import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/** A person's Google account: who it is at Google, what it allowed, and its tokens, encrypted. */
export const googleAccounts = pgTable('google_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** The CMS user who connected it, and the only one who can use it. */
  userId: uuid('user_id').notNull(),
  /** Google's id for the account, which never changes. One CMS user per Google account. */
  subject: text('subject').notNull().unique(),
  email: text('email').notNull(),
  name: text('name').notNull().default(''),
  /** The scopes Google granted, separated by spaces. */
  scopes: text('scopes').notNull().default(''),
  refreshToken: text('refresh_token'),
  accessToken: text('access_token'),
  accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }),
  /** `ok`, or `reconnect` once Google ended the connection. */
  state: text('state').$type<'ok' | 'reconnect'>().notNull().default('ok'),
  /** Why it needs reconnecting, for its owner. */
  problem: text('problem'),
  /** Its owner lets the site send email from it. */
  sendsMail: boolean('sends_mail').notNull().default(false),
  /** The site's own email goes out from it. One account at most. */
  siteMail: boolean('site_mail').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
