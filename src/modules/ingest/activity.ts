import { afterCommit } from '@linagora/twake-node-server/postgres'
import { and, eq, inArray, notExists, sql } from 'drizzle-orm'
import type { Publishers } from '../../config.ts'
import {
  audienceOf,
  deliveryBody,
  parseCloudEvent,
  type CloudEvent
} from '../../events/envelope.ts'
import { RejectedEventError } from '../../events/errors.ts'
import { inTenant, tenantOf, type Db } from '../../infra/db.ts'
import {
  deliveries,
  disabledMembers,
  seenEvents,
  subscriptions
} from '../../infra/schema.ts'

export type IngestOutcome = 'queued' | 'unmatched' | 'duplicate' | 'ignored'

const APP_OF_TYPE = /^com\.twake\.([a-z][a-z0-9-]*)\./

// An app may only publish its own events: the type names the app, and the
// source must be that app's. The AMQP user-id, which the broker checks against
// the user that published, is not read yet: @linagora/rabbitmq-client does not
// pass it on.
export function checkPublisher(
  event: CloudEvent,
  publishers: Publishers
): 'ok' | 'unknown_app' {
  const app = APP_OF_TYPE.exec(event.type)?.[1]
  const publisher =
    app === undefined || !Object.hasOwn(publishers, app)
      ? undefined
      : publishers[app]
  if (publisher === undefined) return 'unknown_app'
  if (event.source !== publisher.source) {
    throw new RejectedEventError(
      `the source of ${event.type} is not ${publisher.source}`
    )
  }
  return 'ok'
}

export function activityHandler(deps: {
  db: Db
  publishers: Publishers
  // Tells the delivery worker that deliveries are waiting.
  wake: () => void
}) {
  return async (body: unknown): Promise<IngestOutcome> => {
    const parsed = parseCloudEvent(body)
    if (!parsed.ok) {
      throw new RejectedEventError(`malformed event: ${parsed.error}`)
    }
    const event = parsed.event
    if (checkPublisher(event, deps.publishers) === 'unknown_app') {
      return 'ignored'
    }
    const audience = audienceOf(event)
    if (audience.length === 0) return 'unmatched'
    const organizationId = event.twakeorg ?? null

    return inTenant(deps.db, { organizationId }, async tx => {
      const matched = await tx
        .select({ id: subscriptions.id, owner: subscriptions.owner })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.tenant, tenantOf(organizationId)),
            inArray(subscriptions.owner, audience),
            sql`${event.type} = any(${subscriptions.types})`,
            notExists(
              tx
                .select({ one: sql`1` })
                .from(disabledMembers)
                .where(
                  and(
                    eq(disabledMembers.orgId, subscriptions.orgId),
                    eq(disabledMembers.owner, subscriptions.owner)
                  )
                )
            )
          )
        )
      if (matched.length === 0) return 'unmatched'
      // Written with the deliveries, so a redelivered event is either fully
      // queued already or not at all.
      const seen = await tx
        .insert(seenEvents)
        .values({ source: event.source, id: event.id })
        .onConflictDoNothing()
        .returning({ id: seenEvents.id })
      if (seen.length === 0) return 'duplicate'
      const payload = deliveryBody(event)
      await tx.insert(deliveries).values(
        matched.map(subscription => ({
          subscriptionId: subscription.id,
          orgId: organizationId,
          owner: subscription.owner,
          eventId: event.id,
          body: payload
        }))
      )
      afterCommit(tx, deps.wake)
      return 'queued'
    })
  }
}
