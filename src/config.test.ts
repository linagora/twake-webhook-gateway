import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

const base = {
  AMQP_URL: 'amqp://guest:guest@localhost:5672',
  PUBLISHERS: '{"tasks":{"source":"twake://tasks"}}',
  DATABASE_URL: 'postgres://gateway:gateway@localhost:5432/gateway',
  OIDC_ISSUER: 'https://auth.example.com/',
  OIDC_CLIENT_ID: 'twake-webhook-gateway',
  OIDC_CLIENT_SECRET: 'secret',
  ALLOWED_URL_PREFIXES:
    'https://n8n.example.com/webhook/, https://n8n.example.com/webhook-test/',
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64')
}

describe('loadConfig', () => {
  it('defaults to the topology of ADR 075', () => {
    const config = loadConfig(base)
    expect(config.AMQP_EXCHANGE).toBe('activity')
    expect(config.AMQP_QUEUE).toBe('twake-webhook-gateway')
    expect(config.AMQP_DEAD_LETTER_EXCHANGE).toBe('twake-webhook-gateway.dlx')
    expect(config.DATABASE_MIGRATION_URL).toBe(base.DATABASE_URL)
    expect(config.OIDC_AUDIENCE).toBe('twake-webhook-gateway')
    expect(config.MAX_SUBSCRIPTIONS_PER_USER).toBe(100)
    expect(config.DELIVERY_MAX_AGE_HOURS).toBe(24)
    expect(config.SUBSCRIPTION_FAILURE_DAYS).toBe(7)
    expect(config.ALLOWED_URL_PREFIXES).toEqual([
      { protocol: 'https:', host: 'n8n.example.com', path: '/webhook/' },
      { protocol: 'https:', host: 'n8n.example.com', path: '/webhook-test/' }
    ])
    expect(config.ALLOWED_PRIVATE_NETWORKS).toEqual([])
    expect(config.PUBLISHERS).toEqual({
      tasks: { source: 'twake://tasks' }
    })
  })

  it('refuses a broker user, which it cannot check yet', () => {
    expect(() =>
      loadConfig({
        ...base,
        PUBLISHERS: '{"tasks":{"source":"twake://tasks","user":"twake-tasks"}}'
      })
    ).toThrow(/not supported yet/)
  })

  it('refuses an http prefix', () => {
    expect(() =>
      loadConfig({ ...base, ALLOWED_URL_PREFIXES: 'http://n8n.example.com/' })
    ).toThrow(/must be https/)
  })

  it('refuses a key that is not 32 bytes', () => {
    expect(() =>
      loadConfig({ ...base, SECRET_ENCRYPTION_KEY: 'c2hvcnQ=' })
    ).toThrow(/32 bytes/)
  })

  it('refuses an unknown publisher field and an empty list', () => {
    expect(() =>
      loadConfig({ ...base, PUBLISHERS: '{"tasks":{"source":"x","y":1}}' })
    ).toThrow(/PUBLISHERS/)
    expect(() => loadConfig({ ...base, PUBLISHERS: '{}' })).toThrow(
      /at least one app/
    )
  })

  it('reads the private networks a delivery may reach', () => {
    const config = loadConfig({
      ...base,
      ALLOWED_PRIVATE_NETWORKS: '172.27.0.0/16'
    })
    expect(config.ALLOWED_PRIVATE_NETWORKS).toEqual([
      { address: '172.27.0.0', prefix: 16, family: 'ipv4' }
    ])
  })

  it('refuses account exchanges that reuse another one', () => {
    expect(() => loadConfig({ ...base, AUTH_EXCHANGE: 'activity' })).toThrow(
      /must differ/
    )
  })
})
