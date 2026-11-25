import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  apiAnswer,
  apiRequest,
  apiUrl,
  GoogleError,
  googleUrl,
  isGoogleUrl,
  readIdToken,
  retryable,
} from '../src/google'

const CLIENT_ID = 'client.apps.googleusercontent.com'
const NOW = Date.UTC(2026, 10, 26)

const idToken = (claims: Record<string, unknown>) => {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'RS256' })}.${part({
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: NOW / 1000 + 3600,
    sub: '1001',
    email: 'Ada@Gmail.com',
    email_verified: true,
    name: 'Ada',
    ...claims,
  })}.sig`
}

describe('Google’s addresses', () => {
  it('are Google’s, or the stand-in’s when one is named', () => {
    expect(googleUrl('oauth2.googleapis.com', '/token', {})).toBe(
      'https://oauth2.googleapis.com/token',
    )
    expect(
      googleUrl('oauth2.googleapis.com', '/token', { GOOGLE_API_URL: 'http://127.0.0.1:3511' }),
    ).toBe('http://127.0.0.1:3511/oauth2.googleapis.com/token')
    expect(
      googleUrl('a.googleapis.com', '/x', { GOOGLE_API_URL: 'https://stand-in.test/base' }),
    ).toBe('https://stand-in.test/a.googleapis.com/x')
  })

  it('never take a stand-in that could be a way into a network', () => {
    for (const value of [
      'http://10.0.0.5:8080',
      'http://169.254.169.254',
      'http://metadata.google.internal',
      'ftp://127.0.0.1',
      'not an address',
    ]) {
      expect(() => googleUrl('oauth2.googleapis.com', '/token', { GOOGLE_API_URL: value })).toThrow(
        /GOOGLE_API_URL/,
      )
    }
  })

  it('know one of Google’s own from anything else', () => {
    expect(isGoogleUrl('https://www.googleapis.com/upload/youtube/v3/videos?upload_id=x', {})).toBe(
      true,
    )
    expect(isGoogleUrl('https://googleapis.com/x', {})).toBe(true)
    for (const value of [
      'http://www.googleapis.com/upload',
      'https://googleapis.com.evil.test/upload',
      'https://evilgoogleapis.com/upload',
      'https://www.googleapis.com@evil.test/',
      'https://evil.test/?https://www.googleapis.com',
      '//www.googleapis.com/x',
      '',
    ]) {
      expect({ value, google: isGoogleUrl(value, {}) }).toEqual({ value, google: false })
    }
    const env = { GOOGLE_API_URL: 'http://127.0.0.1:3511' }
    expect(isGoogleUrl('http://127.0.0.1:3511/www.googleapis.com/upload', env)).toBe(true)
    expect(isGoogleUrl('http://127.0.0.1:9999/www.googleapis.com/upload', env)).toBe(false)
  })

  it('carry a query, lists by repeating the name', () => {
    expect(
      apiUrl('https://x.test/a', {
        part: ['snippet', 'status'],
        max: 5,
        mine: true,
        skip: undefined,
      }),
    ).toBe('https://x.test/a?part=snippet&part=status&max=5&mine=true')
  })
})

describe('an ID token', () => {
  it('says who signed in', () => {
    expect(readIdToken(idToken({ hd: 'Example.com' }), CLIENT_ID, NOW)).toEqual({
      subject: '1001',
      email: 'ada@gmail.com',
      emailVerified: true,
      name: 'Ada',
      hostedDomain: 'example.com',
    })
    expect(readIdToken(idToken({}), CLIENT_ID, NOW).hostedDomain).toBeNull()
    // "true" as text isn't verified.
    expect(readIdToken(idToken({ email_verified: 'true' }), CLIENT_ID, NOW).emailVerified).toBe(
      false,
    )
  })

  it('is refused when it’s for another client, from elsewhere, out of date or without an id', () => {
    const refused = (claims: Record<string, unknown>) =>
      expect(() => readIdToken(idToken(claims), CLIENT_ID, NOW)).toThrow(GoogleError)
    refused({ aud: 'another-client' })
    refused({ aud: [CLIENT_ID] })
    refused({ iss: 'https://accounts.evil.test' })
    refused({ exp: NOW / 1000 - 3600 })
    refused({ exp: 'never' })
    refused({ sub: '' })
    refused({ sub: 'has space' })
    refused({ sub: 12 })
    for (const value of [
      null,
      '',
      'one-part',
      'a.b',
      'a.!!!.c',
      `a.${Buffer.from('[1]').toString('base64url')}.c`,
    ]) {
      expect(() => readIdToken(value, CLIENT_ID, NOW)).toThrow(GoogleError)
    }
    // A minute's difference between clocks is forgiven.
    expect(readIdToken(idToken({ exp: NOW / 1000 - 30 }), CLIENT_ID, NOW).subject).toBe('1001')
  })
})

describe('an API’s answer', () => {
  const answer = (status: number, body: unknown) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status })
  const failure = (status: number, reason: string, message = 'Said by Google') =>
    answer(status, { error: { code: status, message, errors: [{ reason }] } })
  const kindOf = async (response: Response) =>
    apiAnswer(response).then(
      () => 'ok',
      (error: unknown) => (error instanceof GoogleError ? error.kind : 'other'),
    )

  it('is its JSON, or nothing for an empty one', async () => {
    expect(await apiAnswer(answer(200, { items: [1] }))).toEqual({ items: [1] })
    expect(await apiAnswer(answer(204, null))).toBeNull()
  })

  it('becomes an error that says what kind of trouble it is', async () => {
    expect(await kindOf(failure(401, 'authError'))).toBe('reconnect')
    expect(await kindOf(failure(404, 'notFound'))).toBe('not_found')
    expect(await kindOf(failure(403, 'quotaExceeded'))).toBe('limit')
    expect(await kindOf(failure(403, 'rateLimitExceeded'))).toBe('limit')
    expect(await kindOf(failure(429, 'whatever'))).toBe('limit')
    expect(await kindOf(failure(403, 'insufficientPermissions'))).toBe('permission')
    expect(await kindOf(failure(503, 'backendError'))).toBe('unavailable')
    expect(await kindOf(failure(400, 'invalid'))).toBe('refused')
    expect(await kindOf(new Response('<html>Bad gateway</html>', { status: 502 }))).toBe(
      'unavailable',
    )
  })

  it('carries Google’s reason for a refusal on one line, and nothing else of the body', async () => {
    const error = await apiAnswer(
      failure(400, 'invalid', `Bad\r\nname\u0000 ${'x'.repeat(500)}`),
    ).then(
      () => new GoogleError('refused', 'no error'),
      (caught: unknown) => caught as GoogleError,
    )
    expect(error.message.startsWith('Google refused: Bad name')).toBe(true)
    expect(/\p{Cc}/u.test(error.message)).toBe(false)
    expect(error.message.length).toBeLessThan(330)
  })

  it('isn’t held in memory past its limit', async () => {
    // Valid JSON, so only its size can be the reason it's refused.
    const huge = new Response(JSON.stringify({ text: 'a'.repeat(9 * 1024 * 1024) }), {
      status: 200,
    })
    await expect(apiAnswer(huge)).rejects.toMatchObject({
      kind: 'unavailable',
      message: 'Google’s answer was larger than expected.',
    })
    const fits = new Response(JSON.stringify({ text: 'a'.repeat(1024 * 1024) }), { status: 200 })
    expect(Object.keys((await apiAnswer(fits)) as object)).toEqual(['text'])
  })

  it('is worth trying again only when Google says so', () => {
    expect([429, 500, 503].every(retryable)).toBe(true)
    expect([200, 400, 401, 403, 404].some(retryable)).toBe(false)
  })
})

describe('a request that Google sends on to another host', () => {
  /** Two servers: the first sends every request on to the second, which says what it was given. */
  async function pair() {
    const seen: { method: string; headers: IncomingHttpHeaders }[] = []
    const second = createServer((request, response) => {
      seen.push({ method: request.method ?? '', headers: request.headers })
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"from":"second"}')
    })
    await new Promise<void>((resolve) => second.listen(0, '127.0.0.1', resolve))
    const target = `http://localhost:${(second.address() as AddressInfo).port}/file`
    const first = createServer((_request, response) => {
      response.writeHead(302, { location: target }).end()
    })
    await new Promise<void>((resolve) => first.listen(0, '127.0.0.1', resolve))
    const close = () =>
      Promise.all([first, second].map((server) => new Promise((done) => server.close(done))))
    return { url: `http://127.0.0.1:${(first.address() as AddressInfo).port}/file`, seen, close }
  }

  it('follows a read, and leaves the token behind when the host changes', async () => {
    const { url, seen, close } = await pair()
    try {
      const response = await apiRequest('secret-token', url)
      expect(await response.json()).toEqual({ from: 'second' })
      expect(seen).toHaveLength(1)
      expect(seen[0]!.headers.authorization).toBeUndefined()
    } finally {
      await close()
    }
  })

  it('never follows anything that writes', async () => {
    const { url, seen, close } = await pair()
    try {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        await expect(apiRequest('secret-token', url, { method, json: {} })).rejects.toMatchObject({
          kind: 'unavailable',
        })
      }
      expect(seen).toEqual([])
    } finally {
      await close()
    }
  })
})
