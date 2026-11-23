import { createHmac, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  decryptSecret,
  encryptSecret,
  newSecret,
  signature
} from './secrets.ts'

describe('secrets', () => {
  const key = randomBytes(32)

  it('are random and prefixed', () => {
    expect(newSecret()).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/)
    expect(newSecret()).not.toBe(newSecret())
  })

  it('come back from their encryption with the key only', () => {
    const secret = newSecret()
    const sealed = encryptSecret(secret, key)
    expect(sealed.toString('utf8')).not.toContain(secret)
    expect(decryptSecret(sealed, key)).toBe(secret)
    expect(() => decryptSecret(sealed, randomBytes(32))).toThrow()
  })

  it('refuse a sealed secret that was changed', () => {
    const sealed = encryptSecret(newSecret(), key)
    sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 1
    expect(() => decryptSecret(sealed, key)).toThrow()
  })
})

describe('signature', () => {
  it('signs <timestamp>.<body> with HMAC-SHA256', () => {
    const body = '{"id":"1"}'
    const expected = createHmac('sha256', 'whsec_test')
      .update(`1700000000.${body}`)
      .digest('hex')
    expect(signature('whsec_test', body, 1_700_000_000)).toBe(
      `t=1700000000,v1=${expected}`
    )
  })
})
