import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { Identity } from '../auth/oidc.ts'
import { parsePrefix, type UrlPrefix } from './allowlist.ts'
import { registerSubscriptionRoutes } from './routes.ts'
import type { Caller, Subscription, SubscriptionStore } from './store.ts'

const ALICE: Identity = {
  userId: '6f1c1b5e-0000-4000-8000-000000000001',
  organizationId: 'acme123',
  clientId: 'n8n',
  expiresAt: new Date(Date.now() + 3_600_000)
}

// Keeps rows per owner and client, as the database does.
function memoryStore(): SubscriptionStore & {
  rows: (Subscription & Caller)[]
} {
  const rows: (Subscription & Caller)[] = []
  const mine = (caller: Caller) =>
    rows.filter(
      row => row.userId === caller.userId && row.clientId === caller.clientId
    )
  return {
    rows,
    create: (caller, input) => {
      const row = {
        ...caller,
        id: crypto.randomUUID(),
        url: input.url,
        types: input.types,
        owner: caller.userId,
        createdAt: new Date('2026-11-23T10:00:00Z'),
        lastSuccessAt: null
      }
      rows.push(row)
      return Promise.resolve({ ok: true, subscription: row, secret: 'whsec_x' })
    },
    list: caller => Promise.resolve(mine(caller)),
    get: (caller, id) =>
      Promise.resolve(mine(caller).find(row => row.id === id) ?? null),
    delete: (caller, id) => {
      const index = rows.findIndex(
        row => row.id === id && mine(caller).includes(row)
      )
      if (index >= 0) rows.splice(index, 1)
      return Promise.resolve(index >= 0)
    }
  }
}

function app(tokens: Record<string, Identity> = { alice: ALICE }) {
  const server = Fastify()
  const store = memoryStore()
  registerSubscriptionRoutes(server, {
    authenticate: token => Promise.resolve(tokens[token] ?? null),
    store,
    prefixes: () => [
      parsePrefix('https://n8n.example.com/webhook/') as UrlPrefix
    ]
  })
  return { server, store }
}

const as = (token: string) => ({ authorization: `Bearer ${token}` })
const valid = {
  url: 'https://n8n.example.com/webhook/abc',
  types: ['com.twake.tasks.task.assigned.v1']
}

describe('subscription routes', () => {
  it('refuse a caller without a valid token', async () => {
    const { server } = app()
    const none = await server.inject({ method: 'GET', url: '/subscriptions' })
    expect(none.statusCode).toBe(401)
    const bad = await server.inject({
      method: 'GET',
      url: '/subscriptions',
      headers: as('stolen')
    })
    expect(bad.statusCode).toBe(401)
  })

  it('create a subscription and show its secret once', async () => {
    const { server } = app()
    const created = await server.inject({
      method: 'POST',
      url: '/subscriptions',
      headers: as('alice'),
      payload: valid
    })
    expect(created.statusCode).toBe(201)
    const body = created.json<{ id: string; secret: string }>()
    expect(body.secret).toBe('whsec_x')
    const read = await server.inject({
      method: 'GET',
      url: `/subscriptions/${body.id}`,
      headers: as('alice')
    })
    expect(read.json()).not.toHaveProperty('secret')
    const listed = await server.inject({
      method: 'GET',
      url: '/subscriptions',
      headers: as('alice')
    })
    expect(listed.json()).toEqual({
      subscriptions: [
        {
          id: body.id,
          url: valid.url,
          types: valid.types,
          owner: ALICE.userId,
          createdAt: '2026-11-23T10:00:00.000Z',
          lastSuccessAt: null
        }
      ]
    })
  })

  it('refuse a URL outside the allowlist', async () => {
    const { server, store } = app()
    const refused = await server.inject({
      method: 'POST',
      url: '/subscriptions',
      headers: as('alice'),
      payload: { ...valid, url: 'https://n8n.example.com/rest/login' }
    })
    expect(refused.statusCode).toBe(400)
    expect(refused.json()).toEqual({ error: 'not_allowed' })
    expect(store.rows).toHaveLength(0)
  })

  it('refuse a body without types', async () => {
    const { server } = app()
    const refused = await server.inject({
      method: 'POST',
      url: '/subscriptions',
      headers: as('alice'),
      payload: { url: valid.url, types: [] }
    })
    expect(refused.statusCode).toBe(400)
  })

  it('hide the subscriptions of another client of the same person', async () => {
    const { server } = app({
      alice: ALICE,
      other: { ...ALICE, clientId: 'another-app' }
    })
    const created = await server.inject({
      method: 'POST',
      url: '/subscriptions',
      headers: as('alice'),
      payload: valid
    })
    const { id } = created.json<{ id: string }>()
    const listed = await server.inject({
      method: 'GET',
      url: '/subscriptions',
      headers: as('other')
    })
    expect(listed.json()).toEqual({ subscriptions: [] })
    const deleted = await server.inject({
      method: 'DELETE',
      url: `/subscriptions/${id}`,
      headers: as('other')
    })
    expect(deleted.statusCode).toBe(404)
    const own = await server.inject({
      method: 'DELETE',
      url: `/subscriptions/${id}`,
      headers: as('alice')
    })
    expect(own.statusCode).toBe(204)
  })
})
