import { setTimeout as sleep } from 'node:timers/promises'
import { and, eq, isNotNull, lt, or, sql } from 'drizzle-orm'
import { inTenant, organizationOf, type Db } from '../../infra/db.ts'
import {
  deliveries,
  disabledMembers,
  subscriptions
} from '../../infra/schema.ts'
import { isAllowed, type UrlPrefix } from '../subscriptions/allowlist.ts'
import { decryptSecret, signature } from '../subscriptions/secrets.ts'
import type { Post } from './transport.ts'

export type DeliveryResult =
  'delivered' | 'failed' | 'expired' | 'gone' | 'refused_url' | 'skipped'

const FIRST_RETRY_MS = 30_000
const MAX_RETRY_MS = 3_600_000
const SUCCESS_WRITE_MS = 60_000

// 30 seconds, then doubling up to an hour, with jitter so that the deliveries
// of an n8n that was down do not all come back at once.
export function retryDelayMs(attempts: number, random = Math.random): number {
  const base = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** (attempts - 1))
  return Math.round(base * (0.8 + 0.4 * random()))
}

export interface WorkerOptions {
  encryptionKey: Buffer
  prefixes: readonly UrlPrefix[]
  concurrency: number
  pollMs: number
  maxAgeMs: number
  // Longer than a delivery may take, so no other replica takes it meanwhile.
  leaseSeconds: number
}

export function deliveryWorker(deps: {
  db: Db
  post: Post
  options: WorkerOptions
  record: (result: DeliveryResult) => void
  logger: { error(object: object, message: string): void }
  now?: () => number
}) {
  const { db, options } = deps
  const now = deps.now ?? Date.now

  async function deliver(id: string, tenant: string): Promise<DeliveryResult> {
    const organizationId = organizationOf(tenant)
    const found = await inTenant(db, { organizationId }, async tx => {
      const [row] = await tx
        .select({
          subscriptionId: subscriptions.id,
          url: subscriptions.url,
          secret: subscriptions.secret,
          body: deliveries.body,
          eventId: deliveries.eventId,
          attempts: deliveries.attempts,
          createdAt: deliveries.createdAt,
          disabled: disabledMembers.owner
        })
        .from(deliveries)
        .innerJoin(
          subscriptions,
          eq(subscriptions.id, deliveries.subscriptionId)
        )
        .leftJoin(
          disabledMembers,
          and(
            eq(disabledMembers.orgId, subscriptions.orgId),
            eq(disabledMembers.owner, subscriptions.owner)
          )
        )
        .where(eq(deliveries.id, id))
      if (row === undefined) return null
      // The operators may have taken the URL out of the allowlist since, and
      // a disabled member's events are not kept.
      if (row.disabled !== null || !isAllowed(row.url, options.prefixes)) {
        await tx.delete(deliveries).where(eq(deliveries.id, id))
        return row.disabled === null
          ? ('refused_url' as const)
          : ('skipped' as const)
      }
      return row
    })
    if (found === null) return 'skipped'
    if (typeof found === 'string') return found

    const timestamp = Math.floor(now() / 1000)
    const secret = decryptSecret(found.secret, options.encryptionKey)
    const answer = await deps.post(
      new URL(found.url),
      {
        'user-agent': 'twake-webhook-gateway',
        'twake-signature': signature(secret, found.body, timestamp),
        'twake-event-id': found.eventId,
        'twake-delivery-id': id
      },
      found.body
    )

    return inTenant(db, { organizationId }, async tx => {
      if ('status' in answer && answer.status >= 200 && answer.status < 300) {
        await tx.delete(deliveries).where(eq(deliveries.id, id))
        // Written once a minute at most, or when it ends a failure.
        await tx
          .update(subscriptions)
          .set({ lastSuccessAt: sql`now()`, failingSince: null })
          .where(
            and(
              eq(subscriptions.id, found.subscriptionId),
              or(
                sql`${subscriptions.lastSuccessAt} is null`,
                lt(
                  subscriptions.lastSuccessAt,
                  new Date(now() - SUCCESS_WRITE_MS)
                ),
                isNotNull(subscriptions.failingSince)
              )
            )
          )
        return 'delivered'
      }
      if ('status' in answer && answer.status === 410) {
        // The subscriber says it is gone for good: its other deliveries go
        // with it.
        await tx
          .delete(subscriptions)
          .where(eq(subscriptions.id, found.subscriptionId))
        return 'gone'
      }
      await tx
        .update(subscriptions)
        .set({
          failingSince: sql`coalesce(${subscriptions.failingSince}, now())`
        })
        .where(eq(subscriptions.id, found.subscriptionId))
      const attempts = found.attempts + 1
      const dueAt = now() + retryDelayMs(attempts)
      if (dueAt - found.createdAt.getTime() > options.maxAgeMs) {
        await tx.delete(deliveries).where(eq(deliveries.id, id))
        return 'expired'
      }
      await tx
        .update(deliveries)
        .set({
          attempts,
          dueAt: new Date(dueAt),
          lastError:
            'status' in answer
              ? `status ${String(answer.status)}`
              : answer.error
        })
        .where(eq(deliveries.id, id))
      return 'failed'
    })
  }

  async function runOnce(): Promise<number> {
    const claimed = await db.execute<{ id: string; tenant: string }>(
      sql`select id, tenant from claim_deliveries(${options.leaseSeconds}, ${options.concurrency})`
    )
    await Promise.all(
      claimed.map(async ({ id, tenant }) => {
        try {
          deps.record(await deliver(id, tenant))
        } catch (error) {
          // Left leased: it is taken again once the lease ends.
          deps.logger.error({ err: error, delivery: id }, 'a delivery failed')
        }
      })
    )
    return claimed.length
  }

  const state = { running: false }
  // Read through a call, as stop() changes it while the loop awaits.
  const isRunning = () => state.running
  let wakeUp: (() => void) | null = null
  let loop: Promise<void> | null = null
  let lastRun = 0

  return {
    runOnce,
    wake() {
      wakeUp?.()
    },
    start() {
      state.running = true
      lastRun = now()
      loop = (async () => {
        while (state.running) {
          let handled = 0
          try {
            handled = await runOnce()
            lastRun = now()
          } catch (error) {
            deps.logger.error({ err: error }, 'claiming deliveries failed')
          }
          if (handled > 0 || !isRunning()) continue
          const controller = new AbortController()
          wakeUp = () => {
            controller.abort()
          }
          await sleep(options.pollMs, undefined, {
            signal: controller.signal
          }).catch(() => undefined)
          wakeUp = null
        }
      })()
    },
    // Whether the loop has claimed deliveries lately, for the liveness probe.
    alive: (withinMs: number) => !state.running || now() - lastRun < withinMs,
    async stop() {
      state.running = false
      wakeUp?.()
      await loop
    }
  }
}

export type DeliveryWorker = ReturnType<typeof deliveryWorker>
