import { describe, expect, it } from 'vitest'
import { checkUrl, parsePrefix, type UrlPrefix } from './allowlist.ts'

const prefixes = [
  'https://n8n.example.com/webhook/',
  'https://n8n.example.com/webhook-test/'
].map(value => parsePrefix(value) as UrlPrefix)

const refusal = (url: string) => {
  const result = checkUrl(url, prefixes)
  return result.ok ? null : result.refusal
}

describe('parsePrefix', () => {
  it('takes a scheme, a host and a path', () => {
    expect(parsePrefix('https://N8N.example.com:8443/webhook/')).toEqual({
      protocol: 'https:',
      host: 'n8n.example.com:8443',
      path: '/webhook/'
    })
  })

  it('refuses what would make the allowlist ambiguous', () => {
    expect(parsePrefix('http://n8n.example.com/webhook/')).toBe('must be https')
    expect(parsePrefix('https://n8n.example.com/webhook')).toBe(
      'must end with /'
    )
    expect(parsePrefix('https://a:b@n8n.example.com/webhook/')).toBe(
      'must carry no user info'
    )
    expect(parsePrefix('https://n8n.example.com/webhook/?a=1')).toBe(
      'must carry no query or fragment'
    )
    expect(parsePrefix('not a url')).toBe('is not a URL')
  })
})

describe('checkUrl', () => {
  it('accepts a URL under a prefix', () => {
    expect(refusal('https://n8n.example.com/webhook/abc')).toBeNull()
    expect(refusal('https://n8n.example.com/webhook-test/abc?x=1')).toBeNull()
  })

  it('refuses another host, port or scheme', () => {
    expect(refusal('https://n8n.example.com.evil.com/webhook/a')).toBe(
      'not_allowed'
    )
    expect(refusal('https://n8n.example.com:444/webhook/a')).toBe('not_allowed')
    expect(refusal('http://n8n.example.com/webhook/a')).toBe('https_only')
  })

  it("refuses n8n's own routes, even through dot segments", () => {
    expect(refusal('https://n8n.example.com/rest/workflows')).toBe(
      'not_allowed'
    )
    expect(refusal('https://n8n.example.com/webhook/../rest/login')).toBe(
      'not_allowed'
    )
    expect(refusal('https://n8n.example.com/webhook/%2e%2e/rest/login')).toBe(
      'not_allowed'
    )
    expect(refusal('https://n8n.example.com/webhook\\..\\rest')).toBe(
      'not_allowed'
    )
    expect(refusal('https://n8n.example.com/webhook/')).toBe('not_allowed')
    expect(refusal('https://n8n.example.com/webhookx/a')).toBe('not_allowed')
  })

  it('refuses user info', () => {
    expect(refusal('https://user:pass@n8n.example.com/webhook/a')).toBe(
      'user_info'
    )
    expect(refusal('https://evil.com@n8n.example.com/webhook/a')).toBe(
      'user_info'
    )
  })

  it('refuses what is not a URL', () => {
    expect(refusal('n8n.example.com/webhook/a')).toBe('invalid_url')
  })
})
