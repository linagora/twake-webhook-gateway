import { describe, expect, it } from 'vitest'
import { organizationOf, tenantOf } from './db.ts'

describe('tenantOf and organizationOf', () => {
  it('encode an organization and B2C users, and decode them back', () => {
    expect(tenantOf('acme123')).toBe('org:acme123')
    expect(tenantOf(null)).toBe('b2c')
    expect(organizationOf(tenantOf('acme123'))).toBe('acme123')
    expect(organizationOf(tenantOf('org:x'))).toBe('org:x')
    expect(organizationOf(tenantOf(null))).toBeNull()
  })
})
