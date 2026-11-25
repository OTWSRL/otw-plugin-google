import { FormButton, ListTable, Notice, Postbox, Views } from '@otwdesign/admin-ui'
import type { AdminPageContext, AdminPageProps, PluginContext } from '@otwdesign/sdk'
import {
  allows,
  canSend,
  countAccounts,
  listAccounts,
  listAllAccounts,
  type GoogleAccount,
} from '../accounts'
import { MANAGE, PROVIDER, signInOn, type GoogleService } from '../config'
import type { ConnectOutcome } from '../oauth'
import { clientOf, servicesOf } from '../runtime'
import { GoogleStyles, longDate, Who } from './parts'

/** What connecting ended with, said to the person. Only these words are ever shown. */
const OUTCOMES: Record<ConnectOutcome, { type: 'success' | 'error' | 'warning'; text: string }> = {
  connected: { type: 'success', text: 'The Google account is connected.' },
  denied: { type: 'warning', text: 'You didn’t allow it at Google, so nothing changed.' },
  expired: { type: 'error', text: 'That took too long, or started in another browser. Try again.' },
  taken: {
    type: 'error',
    text: 'That Google account is connected by someone else on this site. A Google account belongs to one person here.',
  },
  'other-account': {
    type: 'error',
    text: 'You chose a different Google account at Google. Nothing changed: try again and choose the same one.',
  },
  'no-offline': {
    type: 'error',
    text: 'Google didn’t give this site lasting access. Remove this site under your Google account’s security settings, then connect again.',
  },
  unverified: { type: 'error', text: 'Google hasn’t confirmed that account’s email address yet.' },
  setup: {
    type: 'error',
    text: 'Google isn’t set up yet: the client ID or its secret is missing.',
  },
  failed: { type: 'error', text: 'Google couldn’t complete that. Try again in a moment.' },
}

interface Row extends GoogleAccount {
  owner?: string
}

export interface AccountsData {
  view: 'mine' | 'all'
  rows: Row[]
  mine: number
  /** Everyone's, for someone who manages the plugin; `null` otherwise. */
  everyone: number | null
  services: GoogleService[]
  outcome: ConnectOutcome | null
  setup: {
    configured: boolean
    origin: string | null
    signIn: boolean
    siteMail: boolean
    mailerActive: boolean
    sender: string | null
  } | null
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

export async function loadAccounts(
  cms: PluginContext,
  { user, searchParams }: AdminPageContext,
): Promise<AccountsData> {
  const manager = cms.auth.can(user, MANAGE)
  const view = manager && first(searchParams.view) === 'all' ? 'all' : 'mine'
  const mine = await listAccounts(cms, user.id)
  const everyone = manager ? await listAllAccounts(cms) : null
  const outcome = first(searchParams.google) ?? ''
  const origin = cms.settings.get('site.url')
  return {
    view,
    rows: view === 'all' ? everyone! : mine,
    mine: mine.length,
    everyone: manager ? await countAccounts(cms) : null,
    services: servicesOf(cms),
    outcome: Object.hasOwn(OUTCOMES, outcome) ? (outcome as ConnectOutcome) : null,
    setup: manager
      ? {
          configured: clientOf(cms) !== null,
          origin: origin ? new URL(origin).origin : null,
          signIn: signInOn(cms),
          siteMail: cms.settings.get('google.site_mail') === true,
          mailerActive: cms.isActive('mailer'),
          sender: everyone!.find((account) => account.siteMail)?.email ?? null,
        }
      : null,
  }
}

export function AccountsScreen({
  cms,
  data,
  user,
}: AdminPageProps<AccountsData> & { cms: PluginContext }) {
  const start = cms.routes.apiUrl('/oauth/start')
  const action = (name: string) => cms.admin.actionUrl(name)
  const ask = (account: Row, service?: string) =>
    `${start}?${new URLSearchParams({ account: account.id, ...(service ? { service } : {}) })}`
  const here = cms.admin.url('/')
  const own = (account: Row) => account.userId === user.id
  const outcome = data.outcome ? OUTCOMES[data.outcome] : null

  return (
    <>
      <GoogleStyles />
      {outcome && (
        <Notice type={outcome.type} role={outcome.type === 'success' ? 'status' : 'alert'}>
          {outcome.text}
        </Notice>
      )}
      {data.setup && !data.setup.configured && (
        <Notice type="warning">
          <p>
            Google isn’t set up yet. Add the client ID under{' '}
            <a href={cms.admin.url('/settings')}>Google › Settings</a> and its secret as{' '}
            <code>GOOGLE_CLIENT_SECRET</code> in the site’s environment.
          </p>
        </Notice>
      )}
      {data.everyone !== null && (
        <Views
          label="Accounts"
          views={[
            { label: 'Mine', href: here, count: data.mine, current: data.view === 'mine' },
            {
              label: 'Everyone’s',
              href: `${here}?view=all`,
              count: data.everyone,
              current: data.view === 'all',
            },
          ]}
        />
      )}
      <ListTable
        caption="Google accounts"
        rows={data.rows}
        rowKey={(account) => account.id}
        rowActions={(account) => [
          ...(own(account) && account.state === 'reconnect'
            ? [
                <a key="reconnect" href={ask(account)}>
                  Reconnect
                </a>,
              ]
            : []),
          ...(own(account) && data.setup && account.state === 'ok' && !account.siteMail
            ? [
                <FormButton
                  key="site-mail"
                  action={action('site-mail')}
                  fields={{ id: account.id }}
                  variant="link"
                >
                  Use for the site’s email
                </FormButton>,
              ]
            : []),
          ...(own(account) && data.setup && account.siteMail
            ? [
                <FormButton key="site-mail-off" action={action('site-mail-off')} variant="link">
                  Stop using for the site’s email
                </FormButton>,
              ]
            : []),
          ...(own(account) && account.state === 'ok' && !account.siteMail
            ? [
                <FormButton
                  key="sends-mail"
                  action={action('sends-mail')}
                  fields={{ id: account.id, allowed: account.sendsMail ? '0' : '1' }}
                  variant="link"
                >
                  {account.sendsMail
                    ? 'Stop the site sending from it'
                    : 'Let the site send email from it'}
                </FormButton>,
              ]
            : []),
          <FormButton
            key="disconnect"
            action={action('disconnect')}
            fields={{ id: account.id }}
            variant="delete"
          >
            Disconnect
          </FormButton>,
        ]}
        columns={[
          {
            key: 'account',
            label: 'Account',
            render: (account) => (
              <Who
                name={account.name}
                email={account.email}
                note={
                  own(account) && account.email === user.email && data.setup?.signIn !== false
                    ? ' · the account you sign in with'
                    : null
                }
              />
            ),
          },
          ...(data.view === 'all'
            ? [
                {
                  key: 'owner',
                  label: 'Connected by',
                  render: (account: Row) => account.owner ?? '',
                },
              ]
            : []),
          {
            key: 'services',
            label: 'May use',
            render: (account) => {
              const allowed = data.services.filter((service) => allows(account, service))
              const missing = data.services.filter((service) => !allows(account, service))
              return (
                <>
                  {allowed.length > 0
                    ? allowed.map((service) => service.label).join(', ')
                    : 'Nothing yet'}
                  {canSend(account) && !allowed.some((service) => service.id === 'gmail')
                    ? ' · sending email'
                    : null}
                  {own(account) && account.state === 'ok' && missing.length > 0 && (
                    <>
                      <br />
                      {missing.map((service, index) => (
                        <span key={service.id}>
                          {index > 0 && ' · '}
                          <a href={ask(account, service.id)}>Allow {service.label}</a>
                        </span>
                      ))}
                    </>
                  )}
                </>
              )
            },
          },
          {
            key: 'mail',
            label: 'Email from it',
            render: (account) =>
              account.siteMail
                ? 'The site’s email'
                : account.sendsMail
                  ? 'When a message names it'
                  : '—',
          },
          {
            key: 'connected',
            label: 'Connected',
            render: (account) => <span className="num">{longDate(account.createdAt)}</span>,
          },
          {
            key: 'state',
            label: 'State',
            render: (account) =>
              account.state === 'ok' ? (
                <span className="g-state">Connected</span>
              ) : (
                <>
                  <span className="g-state warn">Needs reconnecting</span>
                  {account.problem && (
                    <>
                      <br />
                      <span className="description">{account.problem}</span>
                    </>
                  )}
                </>
              ),
          },
        ]}
        empty={
          data.view === 'all' ? (
            'Nobody has connected a Google account yet.'
          ) : (
            <>
              You haven’t connected a Google account yet. <a href={start}>Connect an account</a> to
              use {data.services.map((service) => service.label).join(', ') || 'Google'} here.
            </>
          )
        }
      />
      <p className="description" style={{ maxWidth: '72ch' }}>
        Each service asks Google only for what it needs, the first time you allow it. Disconnecting
        takes away this site’s access; your Google account stays as it is. Nobody else on this site
        can read your mail or files: an administrator sees that an account is connected and can
        disconnect it, nothing more.
      </p>

      {data.setup && (
        <Postbox id="google-setup" title="Setup">
          <dl className="g-setup">
            <dt>Redirect addresses</dt>
            <dd>
              Add both under <strong>Authorized redirect URIs</strong> of the OAuth client in the
              Google Cloud console
              {data.setup.origin
                ? ':'
                : ', with your site’s address in front (set it under Settings › General › Site address so links are exact):'}
              <br />
              <code>
                {data.setup.origin ?? ''}
                {cms.routes.apiUrl('/oauth/callback')}
              </code>{' '}
              for connecting accounts
              <br />
              <code>
                {data.setup.origin ?? ''}/api/p/core/sign-in/{PROVIDER}/callback
              </code>{' '}
              for “Continue with Google”
            </dd>
            <dt>Signing in</dt>
            <dd>
              {data.setup.signIn
                ? 'The sign-in pages show “Continue with Google”.'
                : data.setup.configured
                  ? 'Switched off under Google › Settings.'
                  : 'Shown once the client is set up.'}
            </dd>
            <dt>The site’s email</dt>
            <dd>
              {data.setup.mailerActive
                ? 'Mailer is active and sends the site’s email.'
                : !data.setup.siteMail
                  ? 'Not sent through Gmail. Switch it on under Google › Settings.'
                  : data.setup.sender
                    ? `Goes out from ${data.setup.sender}.`
                    : 'Switched on, but no account is chosen: use “Use for the site’s email” on one of your accounts above.'}
              {data.setup.siteMail && data.setup.sender && !data.setup.mailerActive && (
                <form method="post" action={action('test-mail')} style={{ marginTop: 8 }}>
                  <label htmlFor="g-test-to" className="screen-reader-text">
                    Send a test email to
                  </label>
                  <input
                    id="g-test-to"
                    type="email"
                    name="to"
                    className="regular-text"
                    defaultValue={user.email}
                    required
                  />{' '}
                  <button type="submit" className="button">
                    Send a test email
                  </button>
                </form>
              )}
            </dd>
            <dt>Google’s limits</dt>
            <dd>
              While the OAuth client is in <strong>Testing</strong> in the Google Cloud console,
              Google ends every connection after 7 days and lets at most 100 people connect.
              Publishing the client lifts that; Gmail and Drive for the public also need Google’s
              verification.
            </dd>
          </dl>
        </Postbox>
      )}
    </>
  )
}
