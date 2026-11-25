import { randomUUID } from 'node:crypto'
import type { PluginContext, User } from '@otwdesign/sdk'
import { and, asc, eq, sql } from 'drizzle-orm'
import { SEND_SCOPE, type GoogleService } from './config'
import {
  apiAnswer,
  apiRequest,
  GoogleError,
  requestToken,
  retryable,
  revokeToken,
  type ApiRequest,
  type GoogleIdentity,
  type TokenGrant,
} from './google'
import { requireClient, sealerOf, UUID } from './runtime'
import { googleAccounts } from './schema'

// A person's Google accounts and their tokens. Every read of an account names its owner, so one
// person's account is never handed to another; the tokens leave this file only inside a request
// to Google.

/** An account as the screens show it: no token in sight. */
export interface GoogleAccount {
  id: string
  userId: string
  subject: string
  email: string
  name: string
  scopes: readonly string[]
  state: 'ok' | 'reconnect'
  problem: string | null
  sendsMail: boolean
  siteMail: boolean
  createdAt: Date
}

type Row = typeof googleAccounts.$inferSelect

/** An access token is renewed this long before Google would refuse it. */
const EXPIRY_MARGIN_MS = 60_000
const RETRIES = 2
const MAX_RETRY_WAIT_MS = 2_000
/** Scopes that allow sending: the narrow one, and the two that include it. */
const SENDING = [
  SEND_SCOPE,
  'https://www.googleapis.com/auth/gmail.modify',
  'https://mail.google.com/',
]

const shown = (row: Row): GoogleAccount => ({
  id: row.id,
  userId: row.userId,
  subject: row.subject,
  email: row.email,
  name: row.name,
  scopes: row.scopes.split(' ').filter(Boolean),
  state: row.state,
  problem: row.problem,
  sendsMail: row.sendsMail,
  siteMail: row.siteMail,
  createdAt: row.createdAt,
})

const bound = (id: string, column: 'refresh' | 'access') => `${id}:${column}`

/** Whether an account has allowed everything a service asks for. */
export const allows = (account: GoogleAccount, service: Pick<GoogleService, 'scopes'>): boolean =>
  service.scopes.every((scope) => account.scopes.includes(scope))

/** Whether an account can send email: by the sending permission, or by all of Gmail. */
export const canSend = (account: GoogleAccount): boolean =>
  SENDING.some((scope) => account.scopes.includes(scope))

/** Why a grant can't become a connected account, for the screen to say. */
export class ConnectError extends Error {
  readonly reason: 'taken' | 'other-account' | 'no-offline' | 'unverified'
  constructor(reason: ConnectError['reason']) {
    super(reason)
    this.name = 'ConnectError'
    this.reason = reason
  }
}

/** The accounts a person connected, oldest first. */
export async function listAccounts(cms: PluginContext, userId: string): Promise<GoogleAccount[]> {
  const rows = await cms.db
    .select()
    .from(googleAccounts)
    .where(eq(googleAccounts.userId, userId))
    .orderBy(asc(googleAccounts.createdAt))
  return rows.map(shown)
}

/** Everyone's accounts with their owners' addresses, for someone who manages the plugin. */
export async function listAllAccounts(
  cms: PluginContext,
): Promise<(GoogleAccount & { owner: string })[]> {
  const rows = await cms.db.select().from(googleAccounts).orderBy(asc(googleAccounts.createdAt))
  const owners = new Map<string, string>()
  for (const id of new Set(rows.map((row) => row.userId))) {
    owners.set(id, (await cms.users.get(id))?.email ?? '')
  }
  return rows.map((row) => ({ ...shown(row), owner: owners.get(row.userId) ?? '' }))
}

async function rowOf(cms: PluginContext, userId: string, id: string): Promise<Row | null> {
  if (!UUID.test(id)) return null
  const [row] = await cms.db
    .select()
    .from(googleAccounts)
    .where(and(eq(googleAccounts.id, id), eq(googleAccounts.userId, userId)))
    .limit(1)
  return row ?? null
}

/** One of a person's own accounts, or `null`: an id that is someone else's finds nothing. */
export async function findAccount(
  cms: PluginContext,
  userId: string,
  id: string,
): Promise<GoogleAccount | null> {
  const row = await rowOf(cms, userId, id)
  return row ? shown(row) : null
}

/** Any account by id, whoever owns it: only for someone who manages the plugin, to disconnect it. */
export async function findAnyAccount(
  cms: PluginContext,
  id: string,
): Promise<GoogleAccount | null> {
  if (!UUID.test(id)) return null
  const [row] = await cms.db.select().from(googleAccounts).where(eq(googleAccounts.id, id)).limit(1)
  return row ? shown(row) : null
}

/** The account the site's email goes out from, if one is chosen and still connected. */
export async function siteMailAccount(cms: PluginContext): Promise<GoogleAccount | null> {
  const [row] = await cms.db
    .select()
    .from(googleAccounts)
    .where(eq(googleAccounts.siteMail, true))
    .limit(1)
  return row ? shown(row) : null
}

/** An account a message's sender names, whose owner lets the site send from it. */
export async function senderAccount(
  cms: PluginContext,
  address: string,
): Promise<GoogleAccount | null> {
  const [row] = await cms.db
    .select()
    .from(googleAccounts)
    .where(and(eq(googleAccounts.email, address.toLowerCase()), eq(googleAccounts.sendsMail, true)))
    .limit(1)
  return row ? shown(row) : null
}

/**
 * Keeps what Google granted: a new account for this person, or more permissions (or a fresh
 * connection) for one they have. `expected` is the account the person set out to change: coming
 * back as a different Google account changes nothing.
 */
export async function saveGrant(
  cms: PluginContext,
  user: User,
  identity: GoogleIdentity,
  grant: TokenGrant,
  expected: string | null,
): Promise<GoogleAccount> {
  if (!identity.email || !identity.emailVerified) throw new ConnectError('unverified')
  const sealer = sealerOf(cms)
  return cms.transaction(async () => {
    const [existing] = await cms.db
      .select()
      .from(googleAccounts)
      .where(eq(googleAccounts.subject, identity.subject))
      .limit(1)
    if (existing && existing.userId !== user.id) throw new ConnectError('taken')
    if (expected && existing?.id !== expected) throw new ConnectError('other-account')
    const id = existing?.id ?? randomUUID()
    // Google sends a refresh token only with a new consent; without one the old one stays, if it
    // still opens.
    const kept =
      existing && sealer.open(existing.refreshToken, bound(id, 'refresh')) !== null
        ? existing.refreshToken
        : null
    const refreshToken = grant.refreshToken
      ? sealer.seal(grant.refreshToken, bound(id, 'refresh'))
      : kept
    if (!refreshToken) throw new ConnectError('no-offline')
    const values = {
      email: identity.email,
      name: identity.name,
      scopes: [...new Set(grant.scopes)].sort().join(' '),
      refreshToken,
      accessToken: sealer.seal(grant.accessToken, bound(id, 'access')),
      accessExpiresAt: new Date(Date.now() + grant.expiresIn * 1000),
      state: 'ok' as const,
      problem: null,
      updatedAt: new Date(),
    }
    const [row] = existing
      ? await cms.db.update(googleAccounts).set(values).where(eq(googleAccounts.id, id)).returning()
      : await cms.db
          .insert(googleAccounts)
          .values({ id, userId: user.id, subject: identity.subject, ...values })
          .returning()
    return shown(row!)
  })
}

async function markReconnect(cms: PluginContext, id: string, problem: string): Promise<void> {
  await cms.db
    .update(googleAccounts)
    .set({
      state: 'reconnect',
      problem,
      refreshToken: null,
      accessToken: null,
      accessExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(eq(googleAccounts.id, id))
}

// One renewal at a time per account in this process: requests that arrive together share it.
const renewing = new Map<string, Promise<string>>()

async function renew(cms: PluginContext, row: Row): Promise<string> {
  const sealer = sealerOf(cms)
  const refreshToken = sealer.open(row.refreshToken, bound(row.id, 'refresh'))
  if (!refreshToken) {
    await markReconnect(cms, row.id, 'Its stored connection can’t be read any more.')
    throw new GoogleError('reconnect', 'This account needs connecting again.')
  }
  let grant: TokenGrant
  try {
    grant = await requestToken(requireClient(cms), {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })
  } catch (error) {
    if (error instanceof GoogleError && error.kind === 'reconnect') {
      await markReconnect(cms, row.id, `Google ended this connection on ${today()}.`)
    }
    throw error
  }
  await cms.db
    .update(googleAccounts)
    .set({
      accessToken: sealer.seal(grant.accessToken, bound(row.id, 'access')),
      accessExpiresAt: new Date(Date.now() + grant.expiresIn * 1000),
      updatedAt: new Date(),
    })
    .where(eq(googleAccounts.id, row.id))
  return grant.accessToken
}

const today = () =>
  new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' })

/** A token Google accepts now for this account: the stored one, or a new one. */
async function accessToken(cms: PluginContext, row: Row, fresh = false): Promise<string> {
  if (row.state !== 'ok' || !row.refreshToken) {
    throw new GoogleError('reconnect', 'This account needs connecting again.')
  }
  if (
    !fresh &&
    row.accessExpiresAt &&
    row.accessExpiresAt.getTime() - EXPIRY_MARGIN_MS > Date.now()
  ) {
    const stored = sealerOf(cms).open(row.accessToken, bound(row.id, 'access'))
    if (stored) return stored
  }
  let pending = renewing.get(row.id)
  if (!pending) {
    pending = renew(cms, row).finally(() => renewing.delete(row.id))
    renewing.set(row.id, pending)
  }
  return pending
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function retryWait(response: Response, attempt: number): number {
  const asked = Number(response.headers.get('retry-after'))
  const ms = Number.isFinite(asked) && asked > 0 ? asked * 1000 : 300 * 3 ** attempt
  return Math.min(ms, MAX_RETRY_WAIT_MS)
}

/**
 * One request to a Google API as one of a person's accounts. Renews the token when Google no
 * longer takes it, and tries again what Google asks to be tried again: reads, and writes that
 * are safe to repeat. `userId` is whose account it must be.
 */
export async function googleFetch(
  cms: PluginContext,
  userId: string,
  accountId: string,
  url: string,
  request: ApiRequest = {},
): Promise<Response> {
  const row = await rowOf(cms, userId, accountId)
  if (!row) throw new GoogleError('not_found', 'That Google account isn’t connected.')
  const repeatable = (request.method ?? 'GET') !== 'POST' && (request.method ?? 'GET') !== 'PATCH'
  let token = await accessToken(cms, row)
  let renewed = false
  for (let attempt = 0; ; attempt++) {
    const response = await apiRequest(token, url, request)
    if (response.status === 401 && !renewed) {
      // The stored token was withdrawn early: one new one, one more try.
      await response.body?.cancel().catch(() => undefined)
      renewed = true
      token = await accessToken(cms, row, true)
      continue
    }
    if (repeatable && retryable(response.status) && attempt < RETRIES) {
      await response.body?.cancel().catch(() => undefined)
      await wait(retryWait(response, attempt))
      continue
    }
    if (response.status === 401) {
      await markReconnect(cms, row.id, `Google ended this connection on ${today()}.`)
    }
    return response
  }
}

/** The same, for a JSON answer: the parsed body, or a `GoogleError` that says what went wrong. */
export async function googleJson<T = unknown>(
  cms: PluginContext,
  userId: string,
  accountId: string,
  url: string,
  request: ApiRequest = {},
): Promise<T> {
  return (await apiAnswer(await googleFetch(cms, userId, accountId, url, request))) as T
}

/**
 * Takes this site's access away at Google, then forgets the account. Google's part is best
 * effort: an account whose connection Google can't be told about is forgotten here all the same.
 */
export async function disconnectAccount(cms: PluginContext, account: GoogleAccount): Promise<void> {
  const [row] = await cms.db
    .select()
    .from(googleAccounts)
    .where(eq(googleAccounts.id, account.id))
    .limit(1)
  if (!row) return
  const sealer = sealerOf(cms)
  const token =
    sealer.open(row.refreshToken, bound(row.id, 'refresh')) ??
    sealer.open(row.accessToken, bound(row.id, 'access'))
  if (token) {
    const revoked = await revokeToken(token).catch(() => false)
    if (!revoked)
      cms.logger.warn('Google could not be told to end a connection', { account: row.id })
  }
  await cms.db.delete(googleAccounts).where(eq(googleAccounts.id, row.id))
}

/** Makes one of a person's accounts the one the site's email goes out from, or none. */
export async function setSiteMail(cms: PluginContext, accountId: string | null): Promise<void> {
  await cms.transaction(async () => {
    await cms.db
      .update(googleAccounts)
      .set({ siteMail: false })
      .where(eq(googleAccounts.siteMail, true))
    if (accountId) {
      await cms.db
        .update(googleAccounts)
        .set({ siteMail: true })
        .where(eq(googleAccounts.id, accountId))
    }
  })
}

/** Whether its owner lets the site send email from an account. */
export async function setSendsMail(
  cms: PluginContext,
  userId: string,
  accountId: string,
  allowed: boolean,
): Promise<void> {
  if (!UUID.test(accountId)) return
  await cms.db
    .update(googleAccounts)
    .set({ sendsMail: allowed })
    .where(and(eq(googleAccounts.id, accountId), eq(googleAccounts.userId, userId)))
}

/** How many accounts there are, for the "Everyone's" count. */
export async function countAccounts(cms: PluginContext): Promise<number> {
  const [row] = await cms.db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(googleAccounts)
  return row?.n ?? 0
}
