// Types for fake-google.mjs, which is plain JavaScript so node can run it for the browser tests.

export interface FakePerson {
  sub: string
  email: string
  email_verified: boolean
  name: string
  hd?: string
}

export interface FakeAnswer {
  status: number
  headers: Record<string, string>
  body: string | Uint8Array
}

export interface FakeRequest {
  method: string
  host: string
  path: string
  query: string
  headers: Record<string, string | undefined>
  body: Buffer
}

export interface FakeCall {
  url: URL
  method: string
  headers: Record<string, string | undefined>
  body: Buffer
  params: Record<string, string>
  who: string
  person: FakePerson
  scopes: string[]
}

export interface FakeGoogle {
  url: string
  people: Record<string, FakePerson>
  grants: Map<string, { scopes: string[]; refresh: Set<string> }>
  access: Map<string, { who: string; scopes: string[]; expires: number }>
  requests: FakeRequest[]
  sent: { id: string; who: string; from: string; mime: string; threadId: string | null }[]
  /** Whatever the service files keep: each casts its own part. */
  data: Record<string, unknown>
  seeds: (() => void)[]
  route(
    method: string,
    host: string,
    pattern: string,
    /** The scopes one of which the token must have; `null` for any token; `false` for no token at all. */
    scope: readonly string[] | null | false,
    handler: (call: FakeCall) => FakeAnswer | Promise<FakeAnswer>,
  ): void
  reset(): void
  authorize(
    authUrl: string,
    who: string,
    options?: { deny?: boolean; only?: string[] | null },
  ): string
  revoke(who: string): void
  expireAccessTokens(): void
  failNext(
    match: string,
    status: number,
    options?: { times?: number; headers?: Record<string, string> },
  ): void
  close(): Promise<void>
}

export const CLIENT: { id: string; secret: string }
export const PEOPLE: Record<string, FakePerson>
export function apiError(status: number, reason: string, message?: string): FakeAnswer
export function jsonAnswer(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): FakeAnswer
export function startFakeGoogle(options?: {
  port?: number
  routes?: ((fake: FakeGoogle) => void)[]
}): Promise<FakeGoogle>
