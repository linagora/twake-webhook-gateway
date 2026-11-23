import { createHash } from 'node:crypto'
import type { Identity, IdentityProvider } from './oidc.ts'

export type Authenticate = (accessToken: string) => Promise<Identity | null>

export class IdentityProviderBusy extends Error {
  override name = 'IdentityProviderBusy'
}

const CACHE_TTL_MS = 60_000
const REFUSED_TTL_MS = 60_000
const CACHE_SIZE = 10_000
const MAX_CHECKS = 50

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

// A token is checked at the SSO once a minute at most, and callers that bring
// the same token together share one check. Tokens are kept by hash only.
export function createAuthenticator(deps: {
  provider: IdentityProvider
  now?: () => number
}): Authenticate {
  const now = deps.now ?? Date.now
  const accepted = new Map<string, { identity: Identity; until: number }>()
  const refused = new Map<string, number>()
  const inFlight = new Map<string, Promise<Identity | null>>()
  let checks = 0

  function remember<V>(map: Map<string, V>, key: string, value: V) {
    map.delete(key)
    if (map.size >= CACHE_SIZE) {
      map.delete(map.keys().next().value as string)
    }
    map.set(key, value)
  }

  async function check(key: string, accessToken: string) {
    if (checks >= MAX_CHECKS) throw new IdentityProviderBusy()
    checks++
    let identity: Identity | null
    try {
      identity = await deps.provider.identify(accessToken)
    } finally {
      checks--
    }
    const at = now()
    if (identity === null) remember(refused, key, at + REFUSED_TTL_MS)
    else {
      remember(accepted, key, {
        identity,
        until: Math.min(identity.expiresAt.getTime(), at + CACHE_TTL_MS)
      })
    }
    return identity
  }

  return async accessToken => {
    const key = sha256(accessToken)
    const at = now()
    const cached = accepted.get(key)
    if (cached !== undefined && cached.until > at) return cached.identity
    if ((refused.get(key) ?? 0) > at) return null
    let pending = inFlight.get(key)
    if (pending === undefined) {
      pending = check(key, accessToken).finally(() => inFlight.delete(key))
      inFlight.set(key, pending)
    }
    return pending
  }
}
