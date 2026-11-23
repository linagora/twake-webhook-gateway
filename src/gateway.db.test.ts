import { createHmac, randomBytes } from 'node:crypto'
import { createDb, type Db } from '@linagora/twake-node-server/postgres'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { RejectedEventError } from './events/errors.ts'
import { assertRowLevelSecurity, inTenant } from './infra/db.ts'
import { deliveries, subscriptions } from './infra/schema.ts'
import { accountHandler } from './modules/accounts/accounts.ts'
import { sweep } from './modules/deliveries/janitor.ts'
import type { Post, PostResult } from './modules/deliveries/transport.ts'
import {
  deliveryWorker,
  type DeliveryResult
} from './modules/deliveries/worker.ts'
import { activityHandler } from './modules/ingest/activity.ts'
import {
  parsePrefix,
  type UrlPrefix
} from './modules/subscriptions/allowlist.ts'
import {
  subscriptionStore,
  type Caller
} from './modules/subscriptions/store.ts'
import { ACTOR, ASSIGNEE, taskAssigned } from './testing/fixtures.ts'
import { freshDatabase, TEST_DATABASE_URL } from './testing/postgres.ts'

const KEY = randomBytes(32)
const URL_PREFIX = parsePrefix('https://n8n.example.com/webhook/') as UrlPrefix
const TYPE = 'com.twake.tasks.task.assigned.v1'
const OTHER = '6f1c1b5e-0000-4000-8000-000000000003'

const caller = (overrides: Partial<Caller> = {}): Caller => ({
  userId: ASSIGNEE,
  organizationId: 'acme123',
  clientId: 'n8n',
  ...overrides
})

const event = (overrides: object = {}) => ({
  ...taskAssigned,
  id: crypto.randomUUID(),
  ...overrides
})

describe.skipIf(TEST_DATABASE_URL === undefined)(
  'the gateway on Postgres',
  () => {
    let database: Awaited<ReturnType<typeof freshDatabase>>
    let db: Db
    let client: postgres.Sql
    let owner: postgres.Sql
    let calls: { url: string; headers: Record<string, string>; body: string }[]
    let answer: PostResult
    let prefixes: UrlPrefix[]
    let results: DeliveryResult[]

    const store = () =>
      subscriptionStore(db, { encryptionKey: KEY, maxPerUser: 3 })
    const ingest = () =>
      activityHandler({
        db,
        publishers: { tasks: { source: 'twake://tasks' } },
        wake: () => undefined
      })
    const accounts = () =>
      accountHandler({ db, logger: { warn: () => undefined } })
    const post: Post = (url, headers, body) => {
      calls.push({ url: url.href, headers, body })
      return Promise.resolve(answer)
    }
    const worker = (now = Date.now) =>
      deliveryWorker({
        db,
        post,
        options: {
          encryptionKey: KEY,
          prefixes,
          concurrency: 10,
          pollMs: 1000,
          maxAgeMs: 24 * 3_600_000,
          leaseSeconds: 60
        },
        record: result => results.push(result),
        logger: console,
        now
      })
    const subscribe = async (who = caller(), types = [TYPE]) => {
      const created = await store().create(who, {
        url: `https://n8n.example.com/webhook/${crypto.randomUUID()}`,
        types
      })
      if (!created.ok) throw new Error(created.error)
      return created
    }

    beforeAll(async () => {
      database = await freshDatabase(TEST_DATABASE_URL ?? '')
      ;({ sql: client, db } = createDb(database.servingUrl, { log: console }))
      owner = postgres(database.ownerUrl, { onnotice: () => undefined })
    })

    afterAll(async () => {
      await client.end()
      await owner.end()
      await database.drop()
    })

    beforeEach(async () => {
      await owner`truncate subscriptions, deliveries, seen_events, disabled_members`
      calls = []
      answer = { status: 200 }
      prefixes = [URL_PREFIX]
      results = []
    })

    it('serves as a role that row level security binds', async () => {
      const warnings: object[] = []
      await assertRowLevelSecurity(client, { warn: w => warnings.push(w) })
      expect(warnings).toEqual([])
    })

    it('sees no row of another tenant, nor one without a tenant set', async () => {
      await subscribe()
      await subscribe(caller({ organizationId: 'other-org' }))
      const visible = await inTenant(db, { organizationId: 'acme123' }, tx =>
        tx.select({ org: subscriptions.orgId }).from(subscriptions)
      )
      expect(visible).toEqual([{ org: 'acme123' }])
      expect(await db.select().from(subscriptions)).toEqual([])
    })

    it('caps the subscriptions of a person', async () => {
      for (let i = 0; i < 3; i++) await subscribe()
      expect(
        await store().create(caller(), {
          url: 'https://n8n.example.com/webhook/x',
          types: [TYPE]
        })
      ).toEqual({ ok: false, error: 'too_many_subscriptions' })
    })

    it('delivers an event to its actor and recipients, signed, once', async () => {
      const assignee = await subscribe()
      const actor = await subscribe(caller({ userId: ACTOR }))
      await subscribe(caller({ userId: OTHER }))
      await subscribe(caller(), ['com.twake.tasks.task.created.v1'])
      await subscribe(caller({ organizationId: 'other-org' }))
      const published = event()

      expect(await ingest()(published)).toBe('queued')
      expect(await ingest()(published)).toBe('duplicate')
      expect(await worker().runOnce()).toBe(2)

      expect(results).toEqual(['delivered', 'delivered'])
      expect(calls.map(call => call.url).sort()).toEqual(
        [assignee.subscription.url, actor.subscription.url].sort()
      )
      const call = calls.find(c => c.url === assignee.subscription.url)
      const [, t = '', v1 = ''] =
        /^t=(\d+),v1=([0-9a-f]+)$/.exec(
          call?.headers['twake-signature'] ?? ''
        ) ?? []
      expect(v1).toBe(
        createHmac('sha256', assignee.secret)
          .update(`${t}.${call?.body ?? ''}`)
          .digest('hex')
      )
      expect(JSON.parse(call?.body ?? '')).toEqual({
        specversion: '1.0',
        id: published.id,
        type: TYPE,
        source: 'twake://tasks',
        time: published.time,
        twakeorg: 'acme123',
        twakeactorid: ACTOR,
        data: {
          object: { type: 'task', id: 'task-1', board: { id: 'board-1' } },
          container: { kind: 'project', id: 'project-1' },
          assignee: { id: 'member-2' }
        }
      })
      expect(await owner`select * from deliveries`).toHaveLength(0)
      const [row] = await owner`
      select last_success_at from subscriptions where id = ${assignee.subscription.id}`
      expect(row?.last_success_at).toBeInstanceOf(Date)
    })

    it('dead letters an event that is malformed', async () => {
      await expect(ingest()({ id: 'x' })).rejects.toBeInstanceOf(
        RejectedEventError
      )
    })

    it('retries a failed delivery later, and ends the subscription on 410', async () => {
      const { subscription } = await subscribe()
      await ingest()(event())
      answer = { status: 503 }
      await worker().runOnce()
      expect(results).toEqual(['failed'])
      const [failed] =
        await owner`select attempts, due_at, last_error from deliveries`
      expect(failed?.attempts).toBe(1)
      expect(failed?.last_error).toBe('status 503')
      expect(failed?.due_at).toBeInstanceOf(Date)
      expect(Number(failed?.due_at)).toBeGreaterThan(Date.now())
      const [failing] = await owner`select failing_since from subscriptions`
      expect(failing?.failing_since).toBeInstanceOf(Date)

      // Due again: the next attempt meets a gone subscriber.
      await owner`update deliveries set due_at = now()`
      answer = { status: 410 }
      await worker().runOnce()
      expect(results).toEqual(['failed', 'gone'])
      expect(
        await owner`select 1 from subscriptions where id = ${subscription.id}`
      ).toHaveLength(0)
    })

    it('drops a delivery after its maximum age', async () => {
      await subscribe()
      await ingest()(event())
      answer = { error: 'ECONNREFUSED' }
      const later = () => Date.now() + 24 * 3_600_000
      await worker(later).runOnce()
      expect(results).toEqual(['expired'])
      expect(await owner`select * from deliveries`).toHaveLength(0)
    })

    it('drops a delivery whose URL left the allowlist', async () => {
      await subscribe()
      await ingest()(event())
      prefixes = [
        parsePrefix('https://other.example.com/webhook/') as UrlPrefix
      ]
      await worker().runOnce()
      expect(results).toEqual(['refused_url'])
      expect(calls).toEqual([])
    })

    it('pauses a disabled member, and resumes them once enabled', async () => {
      await subscribe()
      await ingest()(event())
      const member = { organizationId: 'acme123', uuid: ASSIGNEE }
      await accounts()('b2b.member.disabled', member)
      expect(await owner`select * from deliveries`).toHaveLength(0)
      expect(await ingest()(event())).toBe('unmatched')
      await accounts()('b2b.member.enabled', member)
      expect(await ingest()(event())).toBe('queued')
    })

    it('ends the subscriptions of a deleted person or organization', async () => {
      await subscribe()
      await subscribe(caller({ organizationId: null }))
      await subscribe(caller({ userId: ACTOR }))
      await accounts()('user.deleted', { uuid: ASSIGNEE })
      expect(await owner`select owner from subscriptions`).toEqual([
        { owner: ACTOR }
      ])
      await accounts()('domain.organization.deleted', {
        organizationId: 'acme123'
      })
      expect(await owner`select * from subscriptions`).toHaveLength(0)
    })

    it('ends subscriptions failing for 7 days and forgets old events', async () => {
      const { subscription } = await subscribe()
      await subscribe()
      await owner`
      update subscriptions set failing_since = now() - interval '8 days'
      where id = ${subscription.id}`
      await owner`
      insert into seen_events (source, id, seen_at)
      values ('twake://tasks', 'old', now() - interval '25 hours')`
      expect(await sweep(db, { failureDays: 7 })).toEqual({
        expiredSubscriptions: 1
      })
      expect(await owner`select * from subscriptions`).toHaveLength(1)
      expect(await owner`select * from seen_events`).toHaveLength(0)
    })

    it('lets no other replica take a leased delivery', async () => {
      await subscribe()
      await ingest()(event())
      const [first, second] = await Promise.all([
        db.execute(sql`select id from claim_deliveries(60, 10)`),
        db.execute(sql`select id from claim_deliveries(60, 10)`)
      ])
      expect(first.length + second.length).toBe(1)
      expect(await db.select().from(deliveries)).toEqual([])
    })
  }
)
