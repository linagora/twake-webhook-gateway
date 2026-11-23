import { sql } from 'drizzle-orm'
import type { Db } from '../../infra/db.ts'

const DEDUPE_HOURS = 24

// Every replica runs it: each step is one idempotent statement.
export async function sweep(
  db: Db,
  options: { failureDays: number }
): Promise<{ expiredSubscriptions: number }> {
  await db.execute(sql`select forget_seen_events(${DEDUPE_HOURS})`)
  const [expired] = await db.execute<{ count: number }>(
    sql`select expire_failing_subscriptions(${options.failureDays}) as count`
  )
  return { expiredSubscriptions: expired?.count ?? 0 }
}
