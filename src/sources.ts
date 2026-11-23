import type { Config } from './config.ts'
import type { Source } from './infra/amqp.ts'
import {
  ACCOUNT_KEYS,
  type accountHandler
} from './modules/accounts/accounts.ts'
import type { activityHandler } from './modules/ingest/activity.ts'

// The activity exchange comes first: its `#` names the queue's own binding.
// An account source whose exchange is unset is off.
export function configuredSources(
  config: Pick<Config, 'AMQP_EXCHANGE' | 'AUTH_EXCHANGE' | 'B2B_EXCHANGE'>,
  handlers: {
    activity: ReturnType<typeof activityHandler>
    account: ReturnType<typeof accountHandler>
  }
): [Source, ...Source[]] {
  const account = (exchange: string, keys: readonly [string, ...string[]]) => ({
    exchange,
    routingKeys: keys,
    passive: true,
    handle: (body: unknown, properties: { routingKey: string }) =>
      handlers.account(properties.routingKey, body)
  })
  return [
    {
      exchange: config.AMQP_EXCHANGE,
      routingKeys: ['#'],
      passive: true,
      handle: body => handlers.activity(body)
    },
    ...(config.AUTH_EXCHANGE === undefined
      ? []
      : [account(config.AUTH_EXCHANGE, ACCOUNT_KEYS.auth)]),
    ...(config.B2B_EXCHANGE === undefined
      ? []
      : [account(config.B2B_EXCHANGE, ACCOUNT_KEYS.b2b)])
  ]
}
