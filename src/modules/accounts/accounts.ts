import { and, eq, lte, sql } from 'drizzle-orm'
import { z } from 'zod'
import { RejectedEventError } from '../../events/errors.ts'
import { inTenant, type Db } from '../../infra/db.ts'
import {
  deliveries,
  disabledMembers,
  subscriptions
} from '../../infra/schema.ts'

// The keys the gateway binds for cleanup (ADR 059). It never forwards them.
export const ACCOUNT_KEYS = {
  auth: ['user.deleted'],
  b2b: [
    'domain.user.deleted',
    'domain.organization.deleted',
    'b2b.member.disabled',
    'b2b.member.enabled'
  ]
} as const

export type AccountOutcome = 'applied' | 'skipped'

const userDeleted = z.looseObject({ uuid: z.uuid().optional() })

const organizationDeleted = z.looseObject({
  organizationId: z.string().min(1)
})

const member = z.looseObject({
  organizationId: z.string().min(1),
  uuid: z.uuid(),
  timestamp: z.iso.datetime({ offset: true }).optional()
})

function parse<T>(schema: z.ZodType<T>, body: unknown, key: string): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new RejectedEventError(
      `malformed ${key}: ${z.prettifyError(parsed.error)}`
    )
  }
  return parsed.data
}

export function accountHandler(deps: {
  db: Db
  logger: { warn(object: object, message: string): void }
}) {
  const { db } = deps
  return async (routingKey: string, body: unknown): Promise<AccountOutcome> => {
    switch (routingKey) {
      case 'user.deleted':
      case 'domain.user.deleted': {
        const { uuid } = parse(userDeleted, body, routingKey)
        // A replayed deletion names the account by its uid only; its first
        // announcement already ended the subscriptions.
        if (uuid === undefined) {
          deps.logger.warn(
            { routingKey },
            'a deleted account carries no uuid: nothing to end'
          )
          return 'skipped'
        }
        await db.execute(sql`select forget_owner(${uuid.toLowerCase()})`)
        return 'applied'
      }
      case 'domain.organization.deleted': {
        const { organizationId } = parse(organizationDeleted, body, routingKey)
        await inTenant(db, { organizationId }, async tx => {
          await tx.delete(subscriptions)
          await tx.delete(disabledMembers)
        })
        return 'applied'
      }
      case 'b2b.member.disabled': {
        const event = parse(member, body, routingKey)
        const at =
          event.timestamp === undefined ? new Date() : new Date(event.timestamp)
        const owner = event.uuid.toLowerCase()
        await inTenant(
          db,
          { organizationId: event.organizationId },
          async tx => {
            await tx
              .insert(disabledMembers)
              .values({ orgId: event.organizationId, owner, disabledAt: at })
              .onConflictDoUpdate({
                target: [disabledMembers.orgId, disabledMembers.owner],
                set: {
                  disabledAt: sql`greatest(${disabledMembers.disabledAt}, excluded.disabled_at)`
                }
              })
            // Neither delivered nor kept while the member is disabled.
            await tx.delete(deliveries).where(eq(deliveries.owner, owner))
          }
        )
        return 'applied'
      }
      case 'b2b.member.enabled': {
        const event = parse(member, body, routingKey)
        const at =
          event.timestamp === undefined ? new Date() : new Date(event.timestamp)
        await inTenant(db, { organizationId: event.organizationId }, tx =>
          // An older enabling, handled late, leaves a newer disabling alone.
          tx
            .delete(disabledMembers)
            .where(
              and(
                eq(disabledMembers.owner, event.uuid.toLowerCase()),
                lte(disabledMembers.disabledAt, at)
              )
            )
        )
        return 'applied'
      }
      default:
        return 'skipped'
    }
  }
}
