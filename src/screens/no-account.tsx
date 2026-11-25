import { Notice } from '@otwdesign/admin-ui'
import type { PluginContext } from '@otwdesign/sdk'
import type { GoogleAccount } from '../accounts'
import type { ServiceAccounts } from '../services/shared'

/** What a service's screen shows instead of its content when no account can use it yet. */
export function NoAccount({
  cms,
  found,
  here,
}: {
  cms: PluginContext
  found: ServiceAccounts
  /** This screen's address, to come back to. */
  here: string
}) {
  const start = cms.routes.apiUrl('/oauth/start')
  const link = (account?: GoogleAccount) =>
    `${start}?${new URLSearchParams({
      service: found.service.id,
      next: here,
      ...(account ? { account: account.id } : {}),
    })}`
  const connected = found.accounts.filter((entry) => entry.account.state === 'ok')
  return (
    <Notice type="info">
      {connected.length === 0 ? (
        <p>
          Connect a Google account to use {found.service.label} here.{' '}
          <a href={link()}>Connect an account</a>
        </p>
      ) : (
        <>
          <p>
            None of your Google accounts has allowed {found.service.label} yet. It will ask Google
            to let this site {found.service.asks}.
          </p>
          <p>
            {connected.map(({ account }, index) => (
              <span key={account.id}>
                {index > 0 && ' · '}
                <a href={link(account)}>
                  Allow {found.service.label} for {account.email}
                </a>
              </span>
            ))}
          </p>
        </>
      )}
    </Notice>
  )
}
