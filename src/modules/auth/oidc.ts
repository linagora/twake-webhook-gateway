import * as client from 'openid-client'
import { z } from 'zod'

export interface Identity {
  // The LDAP entryUUID: the person, whatever their email.
  userId: string
  organizationId: string | null
  // The client the token was issued to, its `azp`.
  clientId: string
  expiresAt: Date
}

export interface IdentityProvider {
  identify: (accessToken: string) => Promise<Identity | null>
}

export interface OidcOptions {
  issuer: URL
  clientId: string
  clientSecret: string
  audience: string
}

const userinfoSchema = z.object({
  sub: z.string().min(1),
  uuid: z.uuid(),
  org_id: z.string().min(1).nullish()
})

// openid-client URL-encodes Basic credentials, turning "-" into "%2D", and
// LemonLDAP only decodes them from 2.23. Raw ones work on every version as
// long as the id and secret hold no "%" or ":".
function rawClientSecretBasic(clientSecret: string): client.ClientAuth {
  return (_server, { client_id }, _body, headers) => {
    headers.set(
      'authorization',
      `Basic ${btoa(`${client_id}:${clientSecret}`)}`
    )
  }
}

function hasAudience(aud: string | string[] | undefined, audience: string) {
  return Array.isArray(aud) ? aud.includes(audience) : aud === audience
}

function stringClaim(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

// The token is introspected with the gateway's own client, then the person is
// read from userinfo, as the other Twake backends do (ADR 067).
export async function discoverIdentityProvider(
  options: OidcOptions
): Promise<IdentityProvider> {
  const config = await client.discovery(
    options.issuer,
    options.clientId,
    undefined,
    rawClientSecretBasic(options.clientSecret),
    { timeout: 5 }
  )
  return {
    async identify(accessToken) {
      const token = await client.tokenIntrospection(config, accessToken)
      if (
        !token.active ||
        token.exp === undefined ||
        token.exp * 1000 <= Date.now() ||
        !hasAudience(token.aud, options.audience)
      ) {
        return null
      }
      const clientId = stringClaim(token.azp) ?? stringClaim(token.client_id)
      if (clientId === null) return null
      const userinfo = await client.fetchUserInfo(
        config,
        accessToken,
        // oxlint-disable-next-line typescript/no-deprecated -- the subjects are compared below, refusing the token instead of throwing
        client.skipSubjectCheck
      )
      const parsed = userinfoSchema.safeParse(userinfo)
      if (!parsed.success) return null
      if (token.sub !== undefined && token.sub !== parsed.data.sub) return null
      return {
        userId: parsed.data.uuid.toLowerCase(),
        organizationId: parsed.data.org_id ?? null,
        clientId,
        expiresAt: new Date(token.exp * 1000)
      }
    }
  }
}
