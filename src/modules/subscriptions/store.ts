import { and, count, desc, eq, sql } from 'drizzle-orm'
import { inTenant, type Db } from '../../infra/db.ts'
import { subscriptions } from '../../infra/schema.ts'
import { encryptSecret, newSecret } from './secrets.ts'

export interface Caller {
  userId: string
  organizationId: string | null
  clientId: string
}

export interface Subscription {
  id: string
  url: string
  types: string[]
  owner: string
  createdAt: Date
  lastSuccessAt: Date | null
}

const view = {
  id: subscriptions.id,
  url: subscriptions.url,
  types: subscriptions.types,
  owner: subscriptions.owner,
  createdAt: subscriptions.createdAt,
  lastSuccessAt: subscriptions.lastSuccessAt
}

export type CreateResult =
  | { ok: true; subscription: Subscription; secret: string }
  | { ok: false; error: 'too_many_subscriptions' }

export interface SubscriptionStore {
  create(
    caller: Caller,
    input: { url: string; types: string[] }
  ): Promise<CreateResult>
  list(caller: Caller): Promise<Subscription[]>
  get(caller: Caller, id: string): Promise<Subscription | null>
  delete(caller: Caller, id: string): Promise<boolean>
}

// Row level security keeps a caller to their own tenant and their own rows;
// the client is filtered here, so a second consumer cannot see what n8n made.
export function subscriptionStore(
  db: Db,
  options: { encryptionKey: Buffer; maxPerUser: number }
): SubscriptionStore {
  const scope = (caller: Caller) => ({
    organizationId: caller.organizationId,
    userId: caller.userId
  })
  const mine = (caller: Caller, id?: string) =>
    and(
      eq(subscriptions.owner, caller.userId),
      eq(subscriptions.clientId, caller.clientId),
      id === undefined ? undefined : eq(subscriptions.id, id)
    )

  return {
    create: (caller, input) =>
      inTenant(db, scope(caller), async tx => {
        // Two creations at once would both pass the count otherwise.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${caller.userId}, 0))`
        )
        const [held] = await tx
          .select({ total: count() })
          .from(subscriptions)
          .where(eq(subscriptions.owner, caller.userId))
        if ((held?.total ?? 0) >= options.maxPerUser) {
          return { ok: false, error: 'too_many_subscriptions' } as const
        }
        const secret = newSecret()
        const [created] = await tx
          .insert(subscriptions)
          .values({
            orgId: caller.organizationId,
            owner: caller.userId,
            clientId: caller.clientId,
            url: input.url,
            types: input.types,
            secret: encryptSecret(secret, options.encryptionKey)
          })
          .returning(view)
        if (created === undefined) throw new Error('insert returned no row')
        return { ok: true, subscription: created, secret } as const
      }),

    list: caller =>
      inTenant(db, scope(caller), tx =>
        tx
          .select(view)
          .from(subscriptions)
          .where(mine(caller))
          .orderBy(desc(subscriptions.createdAt))
      ),

    get: (caller, id) =>
      inTenant(db, scope(caller), async tx => {
        const [found] = await tx
          .select(view)
          .from(subscriptions)
          .where(mine(caller, id))
        return found ?? null
      }),

    delete: (caller, id) =>
      inTenant(db, scope(caller), async tx => {
        const deleted = await tx
          .delete(subscriptions)
          .where(mine(caller, id))
          .returning({ id: subscriptions.id })
        return deleted.length > 0
      })
  }
}
