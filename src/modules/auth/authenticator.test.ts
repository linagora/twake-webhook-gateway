import { describe, expect, it, vi } from 'vitest'
import { createAuthenticator, IdentityProviderBusy } from './authenticator.ts'
import type { Identity } from './oidc.ts'

const identity: Identity = {
  userId: '6f1c1b5e-0000-4000-8000-000000000001',
  organizationId: 'acme123',
  clientId: 'n8n',
  expiresAt: new Date(Date.now() + 3_600_000)
}

describe('createAuthenticator', () => {
  it('checks a token once a minute at most', async () => {
    let at = Date.now()
    const identify = vi.fn(() => Promise.resolve(identity))
    const authenticate = createAuthenticator({
      provider: { identify },
      now: () => at
    })
    expect(await authenticate('token')).toEqual(identity)
    expect(await authenticate('token')).toEqual(identity)
    expect(identify).toHaveBeenCalledTimes(1)
    at += 61_000
    await authenticate('token')
    expect(identify).toHaveBeenCalledTimes(2)
  })

  it('shares one check between callers of the same token', async () => {
    const identify = vi.fn(() => Promise.resolve(identity))
    const authenticate = createAuthenticator({ provider: { identify } })
    await Promise.all([authenticate('token'), authenticate('token')])
    expect(identify).toHaveBeenCalledTimes(1)
  })

  it('remembers a refused token for a minute', async () => {
    const identify = vi.fn(() => Promise.resolve(null))
    const authenticate = createAuthenticator({ provider: { identify } })
    expect(await authenticate('bad')).toBeNull()
    expect(await authenticate('bad')).toBeNull()
    expect(identify).toHaveBeenCalledTimes(1)
  })

  it('refuses new checks while too many are in flight', async () => {
    const authenticate = createAuthenticator({
      provider: { identify: () => new Promise(() => undefined) }
    })
    for (let i = 0; i < 50; i++) void authenticate(`token-${String(i)}`)
    await expect(authenticate('one-more')).rejects.toBeInstanceOf(
      IdentityProviderBusy
    )
  })
})
