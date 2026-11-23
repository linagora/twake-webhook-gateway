import {
  lookup as dnsLookup,
  type LookupAddress,
  type LookupOptions
} from 'node:dns'
import { BlockList, isIP } from 'node:net'

// Addresses that are not on the public internet: a delivery could reach the
// platform's own services through them.
const PRIVATE_V4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const

const PRIVATE_V6 = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
] as const

const privateAddresses = new BlockList()
for (const [network, prefix] of PRIVATE_V4) {
  privateAddresses.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of PRIVATE_V6) {
  privateAddresses.addSubnet(network, prefix, 'ipv6')
}

export interface Network {
  address: string
  prefix: number
  family: 'ipv4' | 'ipv6'
}

export function parseNetworks(values: readonly string[]): Network[] | string {
  const networks: Network[] = []
  for (const value of values) {
    const [address = '', prefixText] = value.split('/')
    const version = isIP(address)
    if (version === 0) return `${value} is not a network`
    const max = version === 4 ? 32 : 128
    const prefix = prefixText === undefined ? max : Number(prefixText)
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
      return `${value} has an invalid prefix`
    }
    networks.push({ address, prefix, family: version === 4 ? 'ipv4' : 'ipv6' })
  }
  return networks
}

// An IPv4 address mapped in IPv6, such as ::ffff:10.0.0.1, is checked as the
// IPv4 address it is.
function unmapped(address: string): string {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  return match?.[1] ?? address
}

export type AddressCheck = (address: string) => boolean

export function addressCheck(allowed: readonly Network[]): AddressCheck {
  const allowList = new BlockList()
  for (const network of allowed) {
    allowList.addSubnet(network.address, network.prefix, network.family)
  }
  return value => {
    const address = unmapped(value)
    const family = isIP(address) === 4 ? 'ipv4' : 'ipv6'
    if (/^::ffff:/i.test(address)) return false
    return (
      !privateAddresses.check(address, family) ||
      allowList.check(address, family)
    )
  }
}

export class BlockedAddressError extends Error {
  override name = 'BlockedAddressError'
  readonly code = 'EBLOCKEDADDRESS'
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void

// For http(s).request: resolves the host as Node would, and refuses it when
// one of its addresses is not allowed. The connection then goes to an address
// that was checked, so a second resolution cannot point it elsewhere.
export function guardedLookup(isAllowedAddress: AddressCheck) {
  return (
    hostname: string,
    options: LookupOptions,
    callback: LookupCallback
  ) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, [])
        return
      }
      const blocked = addresses.find(
        candidate => !isAllowedAddress(candidate.address)
      )
      if (blocked !== undefined || addresses.length === 0) {
        callback(
          new BlockedAddressError(`${hostname} resolves to a blocked address`),
          []
        )
        return
      }
      if (options.all === true) callback(null, addresses)
      else {
        const [first] = addresses as [LookupAddress]
        callback(null, first.address, first.family)
      }
    })
  }
}
