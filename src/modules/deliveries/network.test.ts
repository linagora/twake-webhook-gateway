import { describe, expect, it } from 'vitest'
import {
  addressCheck,
  BlockedAddressError,
  guardedLookup,
  parseNetworks,
  type Network
} from './network.ts'

describe('addressCheck', () => {
  const publicOnly = addressCheck([])

  it('allows public addresses', () => {
    expect(publicOnly('93.184.216.34')).toBe(true)
    expect(publicOnly('2606:2800:220:1:248:1893:25c8:1946')).toBe(true)
  })

  it('blocks private, loopback, link-local and mapped addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.27.0.100',
      '192.168.1.1',
      '169.254.169.254',
      '100.86.182.33',
      '0.0.0.0',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1'
    ]) {
      expect(publicOnly(address), address).toBe(false)
    }
  })

  it('allows the private networks the operators list', () => {
    const allowed = addressCheck(
      parseNetworks(['172.27.0.0/16', 'fd00::/8']) as Network[]
    )
    expect(allowed('172.27.0.100')).toBe(true)
    expect(allowed('::ffff:172.27.0.100')).toBe(true)
    expect(allowed('fd00::1')).toBe(true)
    expect(allowed('10.0.0.1')).toBe(false)
  })
})

describe('parseNetworks', () => {
  it('reads addresses and networks', () => {
    expect(parseNetworks(['10.0.0.1', '172.27.0.0/16'])).toEqual([
      { address: '10.0.0.1', prefix: 32, family: 'ipv4' },
      { address: '172.27.0.0', prefix: 16, family: 'ipv4' }
    ])
  })

  it('refuses what is not a network', () => {
    expect(parseNetworks(['example.com'])).toBe('example.com is not a network')
    expect(parseNetworks(['10.0.0.0/33'])).toBe(
      '10.0.0.0/33 has an invalid prefix'
    )
  })
})

describe('guardedLookup', () => {
  const lookup = (check: (address: string) => boolean, all: boolean) =>
    new Promise<unknown>((resolve, reject) => {
      guardedLookup(check)('localhost', { all }, (error, address) => {
        if (error) reject(error)
        else resolve(address)
      })
    })

  it('refuses a host that resolves to a blocked address', async () => {
    await expect(lookup(addressCheck([]), false)).rejects.toBeInstanceOf(
      BlockedAddressError
    )
  })

  it('answers as Node asked when every address is allowed', async () => {
    expect(typeof (await lookup(() => true, false))).toBe('string')
    expect(Array.isArray(await lookup(() => true, true))).toBe(true)
  })
})
