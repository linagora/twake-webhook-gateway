import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes
} from 'node:crypto'

const NONCE_BYTES = 12
const TAG_BYTES = 16

/** A new subscription secret, shown to its creator once. */
export function newSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`
}

// HMAC needs the secret in clear at each delivery, so it is encrypted rather
// than hashed, with a key kept out of the database.
export function encryptSecret(secret: string, key: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([
    cipher.update(secret, 'utf8'),
    cipher.final()
  ])
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext])
}

export function decryptSecret(sealed: Buffer, key: Buffer): string {
  const nonce = sealed.subarray(0, NONCE_BYTES)
  const tag = sealed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([
    decipher.update(sealed.subarray(NONCE_BYTES + TAG_BYTES)),
    decipher.final()
  ]).toString('utf8')
}

/**
 * The `Twake-Signature` header: HMAC-SHA256 of `<timestamp>.<body>` with the
 * subscription's secret, the timestamp in seconds.
 */
export function signature(
  secret: string,
  body: string,
  timestamp: number
): string {
  const digest = createHmac('sha256', secret)
    .update(`${String(timestamp)}.${body}`)
    .digest('hex')
  return `t=${String(timestamp)},v1=${digest}`
}
