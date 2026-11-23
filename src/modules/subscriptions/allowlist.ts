// A URL the operators allow: an exact scheme and host (with its port), and a
// path that subscribed URLs must start with.
export interface UrlPrefix {
  protocol: 'https:'
  host: string
  path: string
}

export type UrlRefusal =
  'invalid_url' | 'https_only' | 'user_info' | 'not_allowed'

// Parsed with the WHATWG parser, the one that checks the URLs, so a prefix
// and a URL are normalised the same way.
export function parsePrefix(value: string): UrlPrefix | string {
  if (!URL.canParse(value)) return 'is not a URL'
  const url = new URL(value)
  if (url.protocol !== 'https:') return 'must be https'
  if (url.username !== '' || url.password !== '') {
    return 'must carry no user info'
  }
  if (url.search !== '' || url.hash !== '') {
    return 'must carry no query or fragment'
  }
  // Without the trailing slash, /webhook would also allow /webhook-test.
  if (!url.pathname.endsWith('/')) return 'must end with /'
  return { protocol: 'https:', host: url.host, path: url.pathname }
}

export function checkUrl(
  value: string,
  prefixes: readonly UrlPrefix[]
): { ok: true; url: URL } | { ok: false; refusal: UrlRefusal } {
  if (!URL.canParse(value)) return { ok: false, refusal: 'invalid_url' }
  const url = new URL(value)
  if (url.protocol !== 'https:') return { ok: false, refusal: 'https_only' }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, refusal: 'user_info' }
  }
  // The parser has already resolved the dot segments, encoded ones included,
  // so a path under the prefix cannot climb out of it.
  const allowed = prefixes.some(
    prefix =>
      prefix.host === url.host &&
      url.pathname.startsWith(prefix.path) &&
      url.pathname.length > prefix.path.length
  )
  return allowed ? { ok: true, url } : { ok: false, refusal: 'not_allowed' }
}

export function isAllowed(
  value: string,
  prefixes: readonly UrlPrefix[]
): boolean {
  return checkUrl(value, prefixes).ok
}
