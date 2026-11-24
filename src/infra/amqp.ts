import {
  DeadLetterError,
  RabbitMQClient,
  type RabbitMQMessageHandler,
  type RabbitMQMessageProperties,
  type SubscribeOptions
} from '@linagora/rabbitmq-client'
import type { Logger } from 'pino'
import type { Config } from '../config.ts'
import { RejectedEventError } from '../events/errors.ts'

const FIRST_RETRY_MS = 1000
const MAX_RETRY_MS = 60_000
const STUCK_MS = 5 * 60_000
// The client reconnects on its own; a broker restart should not restart pods.
const DISCONNECTED_MS = 60_000

export type Handle = (
  body: unknown,
  properties: RabbitMQMessageProperties
) => Promise<string>

// One kind of message the gateway reads, from one exchange.
export interface Source {
  exchange: string
  routingKeys: readonly [string, ...string[]]
  // Another service owns the exchange: check it exists, never declare it.
  passive: boolean
  handle: Handle
}

export type ConsumerStats = ReturnType<typeof consumerStats>

interface Handling {
  since: number
}

export function consumerStats() {
  const outcomes = new Map<string, number>()
  const handling = new Set<Handling>()
  let subscribed = false
  return {
    outcomes,
    started(): Handling {
      const started = { since: Date.now() }
      handling.add(started)
      return started
    },
    ended(started: Handling, outcome: string) {
      handling.delete(started)
      outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1)
    },
    // The client gives up on a subscription it fails to restore, and stays
    // connected without consuming.
    subscribed(ok: boolean) {
      subscribed = ok
    },
    isSubscribed: () => subscribed,
    stuck: () =>
      [...handling].some(({ since }) => Date.now() - since > STUCK_MS)
  }
}

// An idle consumer is alive: only a stuck handler, a lost connection or a lost
// subscription is not.
export function consumerAlive(
  client: Pick<RabbitMQClient, 'isConnected'>,
  stats: ConsumerStats
): () => boolean {
  let disconnectedSince: number | undefined
  return () => {
    if (client.isConnected()) disconnectedSince = undefined
    else disconnectedSince ??= Date.now()
    const lost =
      disconnectedSince !== undefined &&
      Date.now() - disconnectedSince > DISCONNECTED_MS
    return !lost && !stats.stuck() && stats.isSubscribed()
  }
}

// Every source shares one queue; the exchange tells them apart. A message moved
// from the dead letter queue straight to the queue arrives from the default
// exchange, and RabbitMQ keeps the one it was first published to in a header.
// The header is read in that case only: a publisher can set it, and would
// pass its message off as another exchange's.
export function routeMessages(sources: readonly [Source, ...Source[]]): Handle {
  const byExchange = new Map(sources.map(source => [source.exchange, source]))
  if (byExchange.size !== sources.length) {
    throw new Error('two sources read the same exchange')
  }
  return (body, properties) => {
    const firstDeath = properties.headers['x-first-death-exchange']
    const exchange =
      properties.exchange === '' && typeof firstDeath === 'string'
        ? firstDeath
        : properties.exchange
    return (byExchange.get(exchange) ?? sources[0]).handle(body, properties)
  }
}

// The ids a log line may carry of a message: the event's source and id, the
// organization, and the uuid of the person it is about. Never its content, an
// email or the people it lists.
const LOGGED_IDS = [
  'source',
  'id',
  'twakeorg',
  'twakeactorid',
  'organizationId',
  'uuid'
] as const
const MAX_LOGGED_LENGTH = 255

export function loggedIds(body: unknown): Record<string, string> {
  if (typeof body !== 'object' || body === null) return {}
  const record = body as Record<string, unknown>
  return Object.fromEntries(
    LOGGED_IDS.flatMap(name => {
      const value = record[name]
      return typeof value === 'string'
        ? [[name, value.slice(0, MAX_LOGGED_LENGTH)]]
        : []
    })
  )
}

// One line per message handled, as ADR 067 asks.
export function deliveryHandler(
  handle: Handle,
  stats: ConsumerStats,
  logger: {
    info(object: object, message: string): void
    warn(object: object, message: string): void
  }
): RabbitMQMessageHandler {
  return async (body, properties) => {
    const { exchange, routingKey, messageId } = properties
    const line = { exchange, routingKey, messageId, ...loggedIds(body) }
    const started = stats.started()
    try {
      const outcome = await handle(body, properties)
      stats.ended(started, outcome)
      logger.info({ ...line, outcome }, 'event handled')
    } catch (error) {
      if (error instanceof RejectedEventError) {
        stats.ended(started, 'dead_lettered')
        logger.warn(
          { ...line, outcome: 'dead_lettered', reason: error.message },
          'dead lettered a rejected event'
        )
        throw new DeadLetterError(error.message, { cause: error })
      }
      stats.ended(started, 'failed')
      logger.warn({ ...line, outcome: 'failed' }, 'event failed, retried')
      throw error
    }
  }
}

// The first source's first routing key is the subscription's own; every other
// pair is an extra binding to the same queue.
export function subscription(
  config: Pick<Config, 'AMQP_DEAD_LETTER_EXCHANGE' | 'AMQP_DELIVERY_LIMIT'>,
  sources: readonly [Source, ...Source[]]
) {
  return {
    deadLetterExchange: config.AMQP_DEAD_LETTER_EXCHANGE,
    maxRetries: Infinity,
    maxRetryDelay: MAX_RETRY_MS,
    bindings: sources
      .flatMap(({ exchange, routingKeys }) =>
        routingKeys.map(routingKey => ({ exchange, routingKey }))
      )
      .slice(1),
    passiveExchanges: sources
      .filter(source => source.passive)
      .map(source => source.exchange),
    queueArguments: { 'x-delivery-limit': config.AMQP_DELIVERY_LIMIT }
  } satisfies SubscribeOptions
}

export async function startConsumer(
  config: Config,
  logger: Logger,
  stats: ConsumerStats,
  sources: readonly [Source, ...Source[]]
): Promise<RabbitMQClient> {
  const client = new RabbitMQClient({
    url: config.AMQP_URL,
    prefetch: config.AMQP_PREFETCH,
    retryDelay: FIRST_RETRY_MS,
    // The client logs every message at info.
    logger: logger.child({ component: 'amqp' }, { level: 'warn' }),
    hooks: {
      onReconnect: ({ subscriptionsFailed }) => {
        stats.subscribed(subscriptionsFailed === 0)
      }
    }
  })
  await client.init()
  const [first] = sources
  await client.subscribe(
    first.exchange,
    first.routingKeys[0],
    config.AMQP_QUEUE,
    deliveryHandler(routeMessages(sources), stats, logger),
    subscription(config, sources)
  )
  stats.subscribed(true)
  return client
}
