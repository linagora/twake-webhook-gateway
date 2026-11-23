import * as Sentry from '@sentry/node'
import { createServer, handleSignals } from '@linagora/twake-node-server'
import { createDb } from '@linagora/twake-node-server/postgres'
import { pino } from 'pino'
import postgres from 'postgres'
import { loadConfig } from './config.ts'
import { consumerAlive, consumerStats, startConsumer } from './infra/amqp.ts'
import { assertRowLevelSecurity, migrate } from './infra/db.ts'
import { counter, registerMetrics } from './infra/metrics.ts'
import { accountHandler } from './modules/accounts/accounts.ts'
import { createAuthenticator } from './modules/auth/authenticator.ts'
import { discoverIdentityProvider } from './modules/auth/oidc.ts'
import { sweep } from './modules/deliveries/janitor.ts'
import { addressCheck } from './modules/deliveries/network.ts'
import { httpsPost } from './modules/deliveries/transport.ts'
import { deliveryWorker } from './modules/deliveries/worker.ts'
import { activityHandler } from './modules/ingest/activity.ts'
import { registerSubscriptionRoutes } from './modules/subscriptions/routes.ts'
import { subscriptionStore } from './modules/subscriptions/store.ts'
import { configuredSources } from './sources.ts'

const SHUTDOWN_DEADLINE_MS = 25_000
const SWEEP_EVERY_MS = 60_000
const LEASE_SECONDS = 120

const config = loadConfig()
const logger = pino({ level: config.LOG_LEVEL })
const lifecycle = handleSignals({
  log: logger,
  deadlineMs: SHUTDOWN_DEADLINE_MS
})

logger.warn(
  { apps: Object.keys(config.PUBLISHERS) },
  'the AMQP user-id is not checked yet: the events of these apps are trusted on their source alone'
)

if (config.MIGRATE_ON_START) {
  // postgres.js resolves the user as it would to connect, PGUSER included,
  // and opens no connection until a query.
  const serving = postgres(config.DATABASE_URL)
  const servingRole = serving.options.user
  await serving.end()
  await migrate(config.DATABASE_MIGRATION_URL, servingRole, logger)
}
const { sql, db } = createDb(config.DATABASE_URL, {
  log: logger,
  poolMax: config.DATABASE_POOL_MAX
})
await assertRowLevelSecurity(sql, logger)

const provider = await discoverIdentityProvider({
  issuer: new URL(config.OIDC_ISSUER),
  clientId: config.OIDC_CLIENT_ID,
  clientSecret: config.OIDC_CLIENT_SECRET,
  audience: config.OIDC_AUDIENCE
})

const consumer = consumerStats()
const delivered = counter()
const ended = counter()
let accepting = false
let isAlive = () => true

const transport = httpsPost({
  timeoutMs: config.DELIVERY_TIMEOUT_MS,
  isAllowedAddress: addressCheck(config.ALLOWED_PRIVATE_NETWORKS),
  maxSockets: config.DELIVERY_CONCURRENCY
})
const worker = deliveryWorker({
  db,
  post: transport.post,
  options: {
    encryptionKey: config.SECRET_ENCRYPTION_KEY,
    prefixes: config.ALLOWED_URL_PREFIXES,
    concurrency: config.DELIVERY_CONCURRENCY,
    pollMs: config.DELIVERY_POLL_MS,
    maxAgeMs: config.DELIVERY_MAX_AGE_HOURS * 3_600_000,
    leaseSeconds: LEASE_SECONDS
  },
  record: result => {
    delivered.add(result)
    if (result === 'gone') ended.add('gone')
  },
  logger
})

const server = createServer({
  logger,
  isReady: async () =>
    accepting && consumer.isSubscribed() && (await sql`select 1`).length === 1,
  isAlive: () => isAlive()
})
registerSubscriptionRoutes(server, {
  authenticate: createAuthenticator({ provider }),
  store: subscriptionStore(db, {
    encryptionKey: config.SECRET_ENCRYPTION_KEY,
    maxPerUser: config.MAX_SUBSCRIPTIONS_PER_USER
  }),
  prefixes: () => config.ALLOWED_URL_PREFIXES
})
await server.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT })
const metrics = createServer({ logger, isReady: () => Promise.resolve(true) })
registerMetrics(metrics, {
  consumer,
  deliveries: delivered,
  subscriptionsExpired: ended
})
await metrics.listen({ host: config.HTTP_HOST, port: config.METRICS_PORT })

const sources = configuredSources(config, {
  activity: activityHandler({
    db,
    publishers: config.PUBLISHERS,
    wake: () => {
      worker.wake()
    }
  }),
  account: accountHandler({ db, logger })
})
const client = await startConsumer(config, logger, consumer, sources)
worker.start()
const sweeper = setInterval(() => {
  sweep(db, { failureDays: config.SUBSCRIPTION_FAILURE_DAYS }).then(
    ({ expiredSubscriptions }) => {
      if (expiredSubscriptions > 0) ended.add('failing', expiredSubscriptions)
    },
    (error: unknown) => {
      logger.error({ err: error }, 'the sweep failed')
    }
  )
}, SWEEP_EVERY_MS)
const consumerIsAlive = consumerAlive(client, consumer)
isAlive = () => consumerIsAlive() && worker.alive(5 * 60_000)
accepting = true
logger.info(
  {
    queue: config.AMQP_QUEUE,
    exchanges: sources.map(source => source.exchange),
    apps: Object.keys(config.PUBLISHERS)
  },
  'consuming from RabbitMQ'
)

lifecycle.started(async () => {
  accepting = false
  clearInterval(sweeper)
  await Promise.all([client.close(), worker.stop()])
  transport.close()
  await Promise.all([server.close(), metrics.close()])
  await sql.end()
  await Sentry.flush(2000)
})
