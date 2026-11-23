import { sql } from 'drizzle-orm'
import {
  customType,
  index,
  integer,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  type AnyPgColumn
} from 'drizzle-orm/pg-core'

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' })

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea'
})

// B2C rows have no organization. The tenant names both kinds, so a session
// that forgot to set app.tenant, where it reads as empty, matches no row.
const tenant = () =>
  text()
    .notNull()
    .generatedAlwaysAs(
      sql`case when org_id is null then 'b2c' else 'org:' || org_id end`
    )

export const currentTenant = sql`current_setting('app.tenant', true)`
const currentUser = sql`nullif(current_setting('app.user_id', true), '')::uuid`

const tenantPolicy = (column: AnyPgColumn) =>
  pgPolicy('tenant', {
    using: sql`${column} = ${currentTenant}`,
    withCheck: sql`${column} = ${currentTenant}`
  })

// A request sees its caller's rows only. Work on behalf of no one, such as
// matching an event, sets no user and sees the whole tenant.
const ownRows = (column: AnyPgColumn) =>
  pgPolicy('own', {
    as: 'restrictive',
    using: sql`${currentUser} is null or ${column} = ${currentUser}`,
    withCheck: sql`${currentUser} is null or ${column} = ${currentUser}`
  })

export const subscriptions = pgTable.withRLS(
  'subscriptions',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    orgId: text('org_id'),
    tenant: tenant(),
    owner: uuid().notNull(),
    // The `azp` of the token that created it: a client sees its own only.
    clientId: text('client_id').notNull(),
    url: text().notNull(),
    types: text().array().notNull(),
    // AES-256-GCM: the nonce, the tag, then the ciphertext.
    secret: bytea().notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    lastSuccessAt: timestamptz('last_success_at'),
    failingSince: timestamptz('failing_since')
  },
  table => [
    index('subscriptions_match').on(table.tenant, table.owner),
    index('subscriptions_types').using('gin', table.types),
    index('subscriptions_owner').on(table.owner),
    index('subscriptions_failing')
      .on(table.failingSince)
      .where(sql`failing_since is not null`),
    tenantPolicy(table.tenant),
    ownRows(table.owner)
  ]
)

// While a member is disabled, no event is delivered or kept for them.
export const disabledMembers = pgTable.withRLS(
  'disabled_members',
  {
    orgId: text('org_id').notNull(),
    tenant: tenant(),
    owner: uuid().notNull(),
    disabledAt: timestamptz('disabled_at').notNull()
  },
  table => [
    primaryKey({ columns: [table.orgId, table.owner] }),
    tenantPolicy(table.tenant)
  ]
)

export const deliveries = pgTable.withRLS(
  'deliveries',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    orgId: text('org_id'),
    tenant: tenant(),
    owner: uuid().notNull(),
    eventId: text('event_id').notNull(),
    // The JSON sent, kept as text so that every attempt signs the same bytes.
    body: text().notNull(),
    attempts: integer().notNull().default(0),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    dueAt: timestamptz('due_at').notNull().defaultNow(),
    lastError: text('last_error')
  },
  table => [
    index('deliveries_due').on(table.dueAt),
    index('deliveries_subscription').on(table.subscriptionId),
    tenantPolicy(table.tenant)
  ]
)

// One row per event seen, for 24 hours: a redelivered event is not delivered
// twice. It holds no content, so it has no tenant.
export const seenEvents = pgTable(
  'seen_events',
  {
    source: text().notNull(),
    id: text().notNull(),
    seenAt: timestamptz('seen_at').notNull().defaultNow()
  },
  table => [
    primaryKey({ columns: [table.source, table.id] }),
    index('seen_events_seen_at').on(table.seenAt)
  ]
)
