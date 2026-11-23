import { fileURLToPath } from 'node:url'
import {
  createDb,
  migrateDb,
  type Db,
  type Tx
} from '@linagora/twake-node-server/postgres'
import { sql } from 'drizzle-orm'
import type postgres from 'postgres'

export type { Db, Tx }

export const migrationsFolder = fileURLToPath(
  new URL('../../drizzle', import.meta.url)
)

// A tenant is `b2c` or `org:<organization id>`, as the generated `tenant`
// column of the tables computes it.
const B2C = 'b2c'
const ORGANIZATION = 'org:'

/** The tenant of an organization, or of B2C users when it is null. */
export function tenantOf(organizationId: string | null): string {
  return organizationId === null ? B2C : `${ORGANIZATION}${organizationId}`
}

/** The organization of a tenant, null for B2C users. */
export function organizationOf(tenant: string): string | null {
  return tenant === B2C ? null : tenant.slice(ORGANIZATION.length)
}

/**
 * Runs `work` in one transaction that sees the rows of one tenant, and of one
 * person when `userId` is given.
 */
export function inTenant<T>(
  db: Db,
  scope: { organizationId: string | null; userId?: string },
  work: (tx: Tx) => Promise<T>
): Promise<T> {
  return db.transaction(async tx => {
    await tx.execute(
      sql`select set_config('app.tenant', ${tenantOf(scope.organizationId)}, true),
                 set_config('app.user_id', ${scope.userId ?? ''}, true)`
    )
    return work(tx)
  })
}

// The owner of a table can lift its row level security, and a superuser or a
// BYPASSRLS role always does.
export async function assertRowLevelSecurity(
  client: postgres.Sql,
  log: { warn(object: object, message: string): void }
): Promise<void> {
  const [role] = await client<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
    select rolsuper, rolbypassrls from pg_roles where rolname = current_user`
  if (!role || role.rolsuper || role.rolbypassrls) {
    throw new Error(
      'The database role bypasses row level security: connect as a role without SUPERUSER and BYPASSRLS'
    )
  }
  const owned = await client<{ tablename: string }[]>`
    select tablename from pg_tables
    where schemaname = 'public'
      and pg_has_role(current_user, tableowner, 'MEMBER')`
  if (owned.length > 0) {
    log.warn(
      { tables: owned.map(row => row.tablename) },
      'the database role owns tables, so it lifts their row level security: serve as a role without ownership and migrate through DATABASE_MIGRATION_URL'
    )
  }
}

const CROSS_TENANT_FUNCTIONS = [
  'claim_deliveries(integer, integer)',
  'expire_failing_subscriptions(integer)',
  'forget_owner(uuid)',
  'forget_seen_events(integer)'
]

// Granted again on every start, so the tables a migration adds are covered.
async function grantServing(client: postgres.Sql, role: string) {
  const [session] = await client<{ user: string }[]>`
    select current_user as user`
  if (session?.user === role) return
  const to = client(role)
  await client`grant usage on schema public to ${to}`
  await client`grant select, insert, update, delete on all tables in schema public to ${to}`
  for (const fn of CROSS_TENANT_FUNCTIONS) {
    await client.unsafe(`grant execute on function ${fn} to "${role}"`)
  }
}

export async function migrate(
  migrationUrl: string,
  servingRole: string,
  log: { error(object: object, message: string): void }
): Promise<void> {
  const { sql: client } = createDb(migrationUrl, { log, poolMax: 2 })
  try {
    await migrateDb(client, migrationsFolder)
    await grantServing(client, servingRole)
  } finally {
    await client.end()
  }
}
