import { z } from 'zod'
import { parseNetworks } from './modules/deliveries/network.ts'
import { parsePrefix } from './modules/subscriptions/allowlist.ts'

// Number('') is 0, so a blank value would pass as a count of zero.
const count = (min: number) =>
  z.string().trim().min(1).pipe(z.coerce.number<string>().int().min(min))

const port = count(1).pipe(z.number().max(65535))

// Charts often render an unset value as "", which should mean unset.
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(value => (value === '' ? undefined : value), schema.optional())

const flag = z.enum(['true', 'false']).transform(value => value === 'true')

const json = z.string().transform((value, ctx) => {
  try {
    return JSON.parse(value) as unknown
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be JSON' })
    return z.NEVER
  }
})

const list = z.string().transform(value =>
  value
    .split(/[\s,]+/)
    .map(item => item.trim())
    .filter(item => item.length > 0)
)

export const appName = z.string().regex(/^[a-z][a-z0-9-]*$/)

// For example {"tasks":{"source":"twake://tasks"}}: the apps whose events are
// forwarded, and the CloudEvent `source` each one publishes with.
const publishers = json.pipe(
  z
    .record(
      appName,
      z.strictObject({
        source: z.string().min(1),
        // Refused rather than ignored: the gateway cannot check it yet, and an
        // operator setting it would believe it does.
        user: z
          .never({
            error:
              'is not supported yet: @linagora/rabbitmq-client does not pass the AMQP user-id on'
          })
          .optional()
      })
    )
    .refine(apps => Object.keys(apps).length > 0, 'needs at least one app')
)

export type Publishers = z.infer<typeof publishers>

const prefixes = list.transform((values, ctx) => {
  const parsed = []
  for (const value of values) {
    const prefix = parsePrefix(value)
    if (typeof prefix === 'string') {
      ctx.addIssue({ code: 'custom', message: `${value}: ${prefix}` })
      return z.NEVER
    }
    parsed.push(prefix)
  }
  if (parsed.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'needs at least one prefix' })
    return z.NEVER
  }
  return parsed
})

const networks = list.transform((values, ctx) => {
  const parsed = parseNetworks(values)
  if (typeof parsed === 'string') {
    ctx.addIssue({ code: 'custom', message: parsed })
    return z.NEVER
  }
  return parsed
})

// 32 bytes, in base64: the AES-256-GCM key of the subscription secrets.
const encryptionKey = z.string().transform((value, ctx) => {
  const key = Buffer.from(value, 'base64')
  if (key.length !== 32) {
    ctx.addIssue({ code: 'custom', message: 'must be 32 bytes in base64' })
    return z.NEVER
  }
  return key
})

const configSchema = z
  .object({
    AMQP_URL: z.url({ protocol: /^amqps?$/ }),
    AMQP_EXCHANGE: z.string().min(1).default('activity'),
    AMQP_QUEUE: z.string().min(1).default('twake-webhook-gateway'),
    AMQP_DEAD_LETTER_EXCHANGE: optional(z.string().min(1)),
    AMQP_PREFETCH: count(1).default(20),
    // Failures retry in the process, so a redelivery means a crash or a
    // consumer_timeout.
    AMQP_DELIVERY_LIMIT: count(1).default(20),
    // Where ldap-rest announces deleted accounts, usually auth (B2C) and b2b;
    // unset, the gateway ends no subscription when its owner goes.
    AUTH_EXCHANGE: optional(z.string().min(1)),
    B2B_EXCHANGE: optional(z.string().min(1)),
    PUBLISHERS: publishers,

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    // The owner of the tables, which migrates. Unset, DATABASE_URL migrates,
    // and then owns the tables, which lifts their row level security.
    DATABASE_MIGRATION_URL: optional(z.url({ protocol: /^postgres(ql)?$/ })),
    MIGRATE_ON_START: flag.default(true),
    DATABASE_POOL_MAX: count(2).default(10),

    OIDC_ISSUER: z.url({ protocol: /^https?$/ }),
    OIDC_CLIENT_ID: z.string().min(1),
    OIDC_CLIENT_SECRET: z.string().min(1),
    // The audience a token must carry; the client id when unset.
    OIDC_AUDIENCE: optional(z.string().min(1)),

    ALLOWED_URL_PREFIXES: prefixes,
    // Private addresses a delivery may reach, such as the address of an
    // ingress inside the cluster. None by default.
    ALLOWED_PRIVATE_NETWORKS: networks.default([]),
    SECRET_ENCRYPTION_KEY: encryptionKey,
    MAX_SUBSCRIPTIONS_PER_USER: count(1).default(100),

    DELIVERY_TIMEOUT_MS: count(100).default(10_000),
    DELIVERY_CONCURRENCY: count(1).default(10),
    DELIVERY_POLL_MS: count(100).default(1000),
    DELIVERY_MAX_AGE_HOURS: count(1).default(24),
    SUBSCRIPTION_FAILURE_DAYS: count(1).default(7),

    HTTP_HOST: z.string().min(1).default('0.0.0.0'),
    HTTP_PORT: port.default(8080),
    METRICS_PORT: port.default(9464),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info')
  })
  .superRefine((env, ctx) => {
    const seen = new Set([
      env.AMQP_EXCHANGE,
      env.AMQP_DEAD_LETTER_EXCHANGE ?? `${env.AMQP_QUEUE}.dlx`
    ])
    for (const key of ['AUTH_EXCHANGE', 'B2B_EXCHANGE'] as const) {
      const exchange = env[key]
      if (exchange === undefined) continue
      if (seen.has(exchange)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'must differ from the other exchanges'
        })
      }
      seen.add(exchange)
    }
  })
  .transform(env => ({
    ...env,
    AMQP_DEAD_LETTER_EXCHANGE:
      env.AMQP_DEAD_LETTER_EXCHANGE ?? `${env.AMQP_QUEUE}.dlx`,
    DATABASE_MIGRATION_URL: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL,
    OIDC_AUDIENCE: env.OIDC_AUDIENCE ?? env.OIDC_CLIENT_ID
  }))

export type Config = z.infer<typeof configSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env)
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`)
  }
  return result.data
}
