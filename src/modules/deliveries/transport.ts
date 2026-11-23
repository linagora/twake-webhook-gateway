import { Agent, request } from 'node:https'
import { isIP } from 'node:net'
import { guardedLookup, type AddressCheck } from './network.ts'

export type PostResult = { status: number } | { error: string }

export type Post = (
  url: URL,
  headers: Record<string, string>,
  body: string
) => Promise<PostResult>

// The error codes are logged, never the messages, which can name hosts.
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') return code
  return error instanceof Error ? error.name : 'unknown'
}

// One POST, with no redirect followed: a redirect to an internal address
// would get around the allowlist. Every address the host resolves to is
// checked before connecting.
export function httpsPost(options: {
  timeoutMs: number
  isAllowedAddress: AddressCheck
  maxSockets: number
}): { post: Post; close: () => void } {
  const agent = new Agent({ keepAlive: true, maxSockets: options.maxSockets })
  const lookup = guardedLookup(options.isAllowedAddress)
  const post: Post = (url, headers, body) =>
    new Promise(resolve => {
      // Node connects to a literal address without a lookup.
      const host = url.hostname.replace(/^\[|\]$/g, '')
      if (isIP(host) !== 0 && !options.isAllowedAddress(host)) {
        resolve({ error: 'EBLOCKEDADDRESS' })
        return
      }
      const outgoing = request(
        url,
        {
          method: 'POST',
          agent,
          lookup,
          headers: {
            ...headers,
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(body))
          },
          signal: AbortSignal.timeout(options.timeoutMs)
        },
        response => {
          // The answer is not read: only its status counts.
          response.resume()
          response.on('end', () => {
            resolve({ status: response.statusCode ?? 0 })
          })
          response.on('error', error => {
            resolve({ error: errorCode(error) })
          })
        }
      )
      outgoing.on('error', error => {
        resolve({ error: errorCode(error) })
      })
      outgoing.end(body)
    })
  return {
    post,
    close: () => {
      agent.destroy()
    }
  }
}
