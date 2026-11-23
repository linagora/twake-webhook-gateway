import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  IdentityProviderBusy,
  type Authenticate
} from '../auth/authenticator.ts'
import type { Identity } from '../auth/oidc.ts'
import { checkUrl, type UrlPrefix } from './allowlist.ts'
import type { Caller, Subscription, SubscriptionStore } from './store.ts'

const eventType = z
  .string()
  .max(255)
  .regex(/^[a-z0-9]+(\.[a-z0-9-]+)+$/, 'must be a CloudEvent type')

const createBody = z.strictObject({
  url: z.string().max(2048),
  types: z
    .array(eventType)
    .min(1)
    .max(50)
    .transform(types => [...new Set(types)])
})

const idParams = z.object({ id: z.uuid() })

function serialize(subscription: Subscription) {
  return {
    id: subscription.id,
    url: subscription.url,
    types: subscription.types,
    // The uuid of the person, so a subscriber can tell the events about them.
    owner: subscription.owner,
    createdAt: subscription.createdAt.toISOString(),
    lastSuccessAt: subscription.lastSuccessAt?.toISOString() ?? null
  }
}

function unauthorized(reply: FastifyReply) {
  return reply
    .code(401)
    .header('www-authenticate', 'Bearer')
    .send({ error: 'unauthorized' })
}

const BEARER = /^Bearer\s+(\S+)$/i

async function callerOf(
  request: FastifyRequest,
  authenticate: Authenticate
): Promise<Caller | null> {
  const token = BEARER.exec(request.headers.authorization ?? '')?.[1]
  if (token === undefined) return null
  const identity: Identity | null = await authenticate(token)
  if (identity === null) return null
  return {
    userId: identity.userId,
    organizationId: identity.organizationId,
    clientId: identity.clientId
  }
}

export function registerSubscriptionRoutes(
  app: FastifyInstance,
  deps: {
    authenticate: Authenticate
    store: SubscriptionStore
    prefixes: () => readonly UrlPrefix[]
  }
): void {
  app.decorateRequest('caller', null)
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/subscriptions')) return
    const caller = await callerOf(request, deps.authenticate).catch(
      (error: unknown) => {
        if (error instanceof IdentityProviderBusy) return 'busy' as const
        throw error
      }
    )
    if (caller === 'busy') {
      return reply
        .code(503)
        .header('retry-after', 1)
        .send({ error: 'unavailable' })
    }
    if (caller === null) return unauthorized(reply)
    request.caller = caller
  })

  const callerOfRequest = (request: FastifyRequest): Caller => {
    if (request.caller === null) throw new Error('no caller')
    return request.caller
  }

  app.post('/subscriptions', async (request, reply) => {
    const body = createBody.safeParse(request.body)
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: z.prettifyError(body.error)
      })
    }
    const url = checkUrl(body.data.url, deps.prefixes())
    if (!url.ok) return reply.code(400).send({ error: url.refusal })
    const result = await deps.store.create(callerOfRequest(request), {
      url: url.url.href,
      types: body.data.types
    })
    if (!result.ok) return reply.code(409).send({ error: result.error })
    return reply
      .code(201)
      .send({ ...serialize(result.subscription), secret: result.secret })
  })

  app.get('/subscriptions', async request => {
    const found = await deps.store.list(callerOfRequest(request))
    return { subscriptions: found.map(serialize) }
  })

  app.get('/subscriptions/:id', async (request, reply) => {
    const params = idParams.safeParse(request.params)
    if (!params.success) return reply.code(404).send({ error: 'not_found' })
    const found = await deps.store.get(callerOfRequest(request), params.data.id)
    if (found === null) return reply.code(404).send({ error: 'not_found' })
    return serialize(found)
  })

  app.delete('/subscriptions/:id', async (request, reply) => {
    const params = idParams.safeParse(request.params)
    if (!params.success) return reply.code(404).send({ error: 'not_found' })
    const deleted = await deps.store.delete(
      callerOfRequest(request),
      params.data.id
    )
    if (!deleted) return reply.code(404).send({ error: 'not_found' })
    return reply.code(204).send()
  })
}

declare module 'fastify' {
  interface FastifyRequest {
    caller: Caller | null
  }
}
