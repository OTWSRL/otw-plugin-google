import { Notice } from '@otwdesign/admin-ui'
import type { ReactNode } from 'react'
import type { GoogleAccount } from '../accounts'
import { GoogleError } from '../google'

// What the Google screens share: their styles, the account chooser, and how a problem at Google
// is said. Server components only, so nothing here is sent to a browser as script.

/** The screens' own styles, in the page only while one of them is open. */
export function GoogleStyles() {
  return (
    <style href="otw-google" precedence="default">{`
.cms-admin .g-who{display:flex;align-items:center;gap:10px}
.cms-admin .g-face{flex:none;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:var(--wp-highlight);color:#fff;font-weight:600}
.cms-admin .g-who strong{display:block;color:var(--wp-heading)}
.cms-admin .g-who .g-sub{color:var(--wp-muted)}
.cms-admin .g-state{display:inline-flex;align-items:center;gap:6px}
.cms-admin .g-state::before{content:'';width:8px;height:8px;border-radius:50%;background:#1a7f5a}
.cms-admin .g-state.warn::before{background:#b26200}
.cms-admin .g-state.off::before{background:#8c8f94}
.cms-admin .g-switch{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:12px 0 4px}
.cms-admin .g-switch label{font-weight:600;color:var(--wp-heading)}
.cms-admin .g-switch select{min-width:280px;min-height:32px;line-height:30px}
.cms-admin .g-switch .search-box{float:none;margin:0 0 0 auto}
.cms-admin .g-setup code{word-break:break-all}
.cms-admin .g-setup dt{margin-top:10px;font-weight:600;color:var(--wp-heading)}
.cms-admin .g-setup dd{margin:2px 0 0}
.cms-admin .num{font-variant-numeric:tabular-nums}
@media (max-width:782px){.cms-admin .g-switch select{min-width:0;width:100%}.cms-admin .g-switch .search-box{margin:0;width:100%}}
`}</style>
  )
}

/** An account in a table cell or a heading: its initial, its name and its address. */
export function Who({ name, email, note }: { name: string; email: string; note?: ReactNode }) {
  return (
    <div className="g-who">
      <span className="g-face" aria-hidden="true">
        {(name || email).slice(0, 1).toUpperCase()}
      </span>
      <div>
        <strong>{name || email}</strong>
        <span className="g-sub">
          {name ? email : null}
          {note}
        </span>
      </div>
    </div>
  )
}

/**
 * The account a screen shows, chosen in a form that reloads the screen: a plain `<select>` and a
 * button, with no script. Other fields of the screen's address travel as hidden inputs.
 */
export function AccountSwitch({
  label,
  action,
  accounts,
  current,
  keep = {},
  children,
}: {
  label: string
  action: string
  accounts: readonly { account: GoogleAccount; usable: boolean; label?: string }[]
  current: string | null
  keep?: Readonly<Record<string, string | undefined>>
  children?: ReactNode
}) {
  return (
    <form method="get" action={action} className="g-switch">
      <label htmlFor="g-account">{label}</label>
      <select id="g-account" name="account" defaultValue={current ?? undefined}>
        {accounts.map(({ account, usable, label: text }) => (
          <option key={account.id} value={account.id} disabled={!usable}>
            {text ?? account.email}
          </option>
        ))}
      </select>
      {Object.entries(keep).map(([name, value]) =>
        value ? <input key={name} type="hidden" name={name} value={value} /> : null,
      )}
      <button type="submit" className="button button-compact">
        Show
      </button>
      {children}
    </form>
  )
}

/** A problem at Google, said on the screen: what happened, and what to do when there is something. */
export function GoogleProblem({ error, reconnect }: { error: unknown; reconnect?: string }) {
  if (!(error instanceof GoogleError)) throw error
  return (
    <Notice
      type={error.kind === 'limit' || error.kind === 'unavailable' ? 'warning' : 'error'}
      role="alert"
    >
      <p>
        {error.message}{' '}
        {reconnect && (error.kind === 'reconnect' || error.kind === 'permission') ? (
          <a href={reconnect}>Connect it again</a>
        ) : null}
      </p>
    </Notice>
  )
}

/** A date as the admin writes them: 12 November 2026. */
export const longDate = (date: Date): string =>
  date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
