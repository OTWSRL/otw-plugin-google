import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

// What the plugin keeps secret: each account's tokens, encrypted in the database, and the
// cookie that carries a connection to Google and back, signed.

const SEALED = 'v1.'
const SALT = 'otw-plugin-google'

export interface Sealer {
  /**
   * A token as it's stored. `bound` names the row and column it belongs to, so a value copied
   * into another row, or into the other token's column, doesn't open there.
   */
  seal(secret: string, bound: string): string
  /** A stored token, or `null` when it was sealed with another key, for another row, or changed. */
  open(stored: string | null, bound: string): string | null
  /** Signs `payload` for `purpose`; a signature made for one purpose never passes for another. */
  sign(purpose: string, payload: string): string
  verify(purpose: string, payload: string, signature: string): boolean
}

/**
 * The plugin's keys, made from `GOOGLE_TOKEN_KEY` or, without one, from the client secret. Both
 * come from the environment only, so a copy of the database alone opens nothing.
 */
export function createSealer(material: string): Sealer {
  if (!material) throw new Error('The Google plugin has no secret to make its keys from')
  // Derived when first needed: a request that touches no token pays for no key.
  let keys: { seal: Buffer; sign: Buffer } | null = null
  const derived = () =>
    (keys ??= {
      seal: Buffer.from(hkdfSync('sha256', material, SALT, 'tokens', 32)),
      sign: Buffer.from(hkdfSync('sha256', material, SALT, 'signatures', 32)),
    })
  const mac = (purpose: string, payload: string) =>
    createHmac('sha256', derived().sign).update(`${purpose}\n${payload}`).digest()
  return {
    seal(secret, bound) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', derived().seal, iv)
      cipher.setAAD(Buffer.from(bound))
      const sealed = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
      return SEALED + Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url')
    },
    open(stored, bound) {
      if (!stored || !stored.startsWith(SEALED)) return null
      const bytes = Buffer.from(stored.slice(SEALED.length), 'base64url')
      if (bytes.length < 29) return null
      try {
        const decipher = createDecipheriv('aes-256-gcm', derived().seal, bytes.subarray(0, 12))
        decipher.setAAD(Buffer.from(bound))
        decipher.setAuthTag(bytes.subarray(12, 28))
        return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
          'utf8',
        )
      } catch {
        return null
      }
    },
    sign: (purpose, payload) => mac(purpose, payload).toString('base64url'),
    verify(purpose, payload, signature) {
      const expected = mac(purpose, payload)
      const actual = Buffer.from(signature, 'base64url')
      return actual.length === expected.length && timingSafeEqual(actual, expected)
    },
  }
}

/** 32 random bytes as 43 URL-safe characters: a state, or PKCE's code verifier. */
export const randomToken = (): string => randomBytes(32).toString('base64url')

/** PKCE's challenge for a verifier: its SHA-256, URL-safe. */
export const challengeOf = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url')

/** Whether two strings are the same, in the same time whichever they are. */
export function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
