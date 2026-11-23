import { randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { migrate } from '../infra/db.ts'

// A superuser URL: set by CI, or by hand against a disposable Postgres.
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

const OWNER = 'gateway_test_owner'
const SERVING = 'gateway_test_serving'

function withCredentials(url: string, user: string, database: string) {
  const parsed = new URL(url)
  parsed.username = user
  parsed.password = user
  parsed.pathname = `/${database}`
  return parsed.href
}

// A new database, owned by one role that migrates, and served by another that
// owns nothing, as in production.
export async function freshDatabase(adminUrl: string) {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined })
  const name = `gateway_test_${randomBytes(4).toString('hex')}`
  for (const role of [OWNER, SERVING]) {
    await admin.unsafe(`
      do $$ begin
        create role ${role} login password '${role}';
      exception when duplicate_object then null;
      end $$`)
  }
  await admin.unsafe(`create database ${name} owner ${OWNER}`)
  await admin.end()
  const ownerUrl = withCredentials(adminUrl, OWNER, name)
  await migrate(ownerUrl, SERVING, console)
  return {
    ownerUrl,
    servingUrl: withCredentials(adminUrl, SERVING, name),
    async drop() {
      const cleanup = postgres(adminUrl, { max: 1, onnotice: () => undefined })
      await cleanup.unsafe(`drop database if exists ${name} with (force)`)
      await cleanup.end()
    }
  }
}
