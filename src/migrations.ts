import type { Migration } from '@otwdesign/sdk'
import { sql } from 'drizzle-orm'

/** The plugin's tables, for `uninstall()`. */
export const TABLES = ['google_accounts'] as const

export const migrations: Migration[] = [
  {
    id: '0001_accounts',
    up: async (db) => {
      // A person's Google accounts. Nothing from Google is kept but who it is and the tokens,
      // which are encrypted: mail, files and videos are read from Google when they're shown.
      await db.execute(sql`
        CREATE TABLE google_accounts (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id uuid NOT NULL REFERENCES cms_users(id) ON DELETE CASCADE,
          subject text NOT NULL UNIQUE,
          email text NOT NULL,
          name text NOT NULL DEFAULT '',
          scopes text NOT NULL DEFAULT '',
          refresh_token text,
          access_token text,
          access_expires_at timestamptz,
          state text NOT NULL DEFAULT 'ok',
          problem text,
          sends_mail boolean NOT NULL DEFAULT false,
          site_mail boolean NOT NULL DEFAULT false,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await db.execute(sql`CREATE INDEX google_accounts_user_idx ON google_accounts (user_id)`)
      // The site's email goes out from one account.
      await db.execute(
        sql`CREATE UNIQUE INDEX google_accounts_site_mail_idx ON google_accounts (site_mail) WHERE site_mail`,
      )
    },
  },
]
