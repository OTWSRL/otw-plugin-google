import { FormButton, ListTable, Notice } from '@otwdesign/admin-ui'
import type { AdminPageContext, AdminPageProps, PluginContext } from '@otwdesign/sdk'
import { GoogleError } from '../../google'
import { AccountSwitch, GoogleProblem, GoogleStyles } from '../../screens/parts'
import { NoAccount, serviceAccounts, type ServiceAccounts } from '../shared'
import { addressOf, splitList } from './address'
import {
  ALL_MAIL,
  getDraft,
  getMessage,
  getThread,
  GMAIL_ID,
  listLabels,
  listMail,
  listSendAs,
  modifyThread,
  type MailAttachment,
  type MailLabel,
  type MailMessage,
  type Mailbox,
  type SendAs,
  type ThreadSummary,
} from './client'

// The mail screens: a label's conversations, one conversation, the labels, and writing. Server
// components with links and plain forms: a message's own HTML is never part of these pages, it
// sits in a sandboxed frame that `./api` fills.

const MAX_QUERY = 500
/** How much of the message being answered is quoted back. */
const MAX_QUOTED = 50_000

const first = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value) ?? ''

// ── Where a screen is ──────────────────────────────────────────────────────────

interface View {
  account: string
  label: string
  q: string
  /** The page token of the list. */
  page: string
  thread: string
  /** The message whose formatted body is shown; the conversation's last, unless one is named. */
  show: string
  images: boolean
  manage: boolean
}

function viewOf(searchParams: AdminPageContext['searchParams'], account: string): View {
  const pick = (name: string) => {
    const value = first(searchParams[name])
    return GMAIL_ID.test(value) ? value : ''
  }
  const label = first(searchParams.label)
  return {
    account,
    label: label === ALL_MAIL ? ALL_MAIL : pick('label') || 'INBOX',
    // Gmail's own search words, as typed: a line of text, no more.
    q: first(searchParams.q)
      .replace(/\p{Cc}+/gu, ' ')
      .trim()
      .slice(0, MAX_QUERY),
    page: pick('page'),
    thread: pick('thread'),
    show: pick('show'),
    images: first(searchParams.images) === '1',
    manage: first(searchParams.manage) === 'labels',
  }
}

/** The mail screen's address for a view, with what changes in it. */
function mailPath(cms: PluginContext, view: View, change: Partial<View> = {}): string {
  const next = { ...view, ...change }
  const query = new URLSearchParams({ account: next.account })
  if (next.label !== 'INBOX') query.set('label', next.label)
  if (next.q) query.set('q', next.q)
  if (next.page) query.set('page', next.page)
  if (next.thread) query.set('thread', next.thread)
  if (next.show) query.set('show', next.show)
  if (next.images) query.set('images', '1')
  if (next.manage) query.set('manage', 'labels')
  return `${cms.admin.url('/gmail')}?${query}`
}

const composePath = (cms: PluginContext, account: string, extra: Record<string, string> = {}) =>
  `${cms.admin.url('/gmail/compose')}?${new URLSearchParams({ account, ...extra })}`

const when = (date: Date | null): string =>
  date
    ? `${date.toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC',
      })} UTC`
    : ''

const size = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${bytes} bytes`

function MailStyles() {
  return (
    <style href="otw-google-gmail" precedence="default">{`
.cms-admin .g-mail{display:grid;grid-template-columns:180px minmax(0,1fr);gap:16px;align-items:start;margin-top:12px}
.cms-admin .g-labels{margin:0;padding:6px 0;list-style:none;background:#fff;border:1px solid var(--wp-border)}
.cms-admin .g-labels li{margin:0}
.cms-admin .g-labels a{display:flex;justify-content:space-between;gap:8px;padding:6px 12px;color:var(--wp-text);text-decoration:none}
.cms-admin .g-labels a:hover{background:#f6f7f7;color:var(--wp-heading)}
.cms-admin .g-labels .current a{color:var(--wp-heading);font-weight:600;box-shadow:inset 3px 0 0 var(--wp-highlight)}
.cms-admin .g-labels .g-labels-head{padding:12px 12px 4px;color:var(--wp-muted);font-size:11px;text-transform:uppercase}
.cms-admin .g-mail-search{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}
.cms-admin .g-mail-search input[type=search]{flex:1;min-width:200px;max-width:480px;min-height:32px;line-height:30px}
.cms-admin .g-mail-tools{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 10px}
.cms-admin .g-mail-tools .inline-form{display:inline}
.cms-admin .g-unread .row-title{font-weight:600;color:var(--wp-heading)}
.cms-admin .g-thread{background:#fff;border:1px solid var(--wp-border);padding:16px 20px}
.cms-admin .g-thread h2{margin:0 0 12px;font-size:18px}
.cms-admin .g-message{border-top:1px solid #dcdcde;padding:12px 0}
.cms-admin .g-message header{display:flex;justify-content:space-between;gap:12px;align-items:baseline;flex-wrap:wrap}
.cms-admin .g-message .g-to{color:var(--wp-muted)}
.cms-admin .g-mail-text{max-width:80ch;margin:10px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.55 inherit;font-family:inherit;color:var(--wp-heading)}
.cms-admin .g-mail-frame{display:block;width:100%;height:480px;margin:10px 0 0;border:1px solid #dcdcde;background:#fff}
.cms-admin .g-attachments{margin:10px 0 0;padding:0;list-style:none}
.cms-admin .g-attachments li{display:inline-block;margin:0 8px 6px 0;padding:5px 10px;border:1px solid var(--wp-border);background:#f6f7f7}
.cms-admin .g-compose{display:grid;gap:8px;max-width:760px}
.cms-admin .g-compose .g-line{display:grid;grid-template-columns:70px minmax(0,1fr);gap:8px;align-items:center}
.cms-admin .g-compose input[type=text],.cms-admin .g-compose select,.cms-admin .g-compose textarea{width:100%;box-sizing:border-box}
.cms-admin .g-compose textarea{min-height:280px;font-size:14px;line-height:1.5}
.cms-admin .g-compose .g-acts{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.cms-admin .g-label-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 8px}
.cms-admin .g-label-row .inline-form{display:inline}
@media (max-width:782px){.cms-admin .g-mail{grid-template-columns:minmax(0,1fr)}.cms-admin .g-labels{display:flex;flex-wrap:wrap}.cms-admin .g-labels .g-labels-head{display:none}.cms-admin .g-compose .g-line{grid-template-columns:minmax(0,1fr)}}
`}</style>
  )
}

// ── The mail screen ────────────────────────────────────────────────────────────

export interface MailData {
  found: ServiceAccounts | null
  view: View
  labels: MailLabel[]
  threads: ThreadSummary[]
  /** The next page of the list, or `null`. */
  next: string | null
  /** The open conversation's messages; `null` when none is open, or it's gone. */
  thread: MailMessage[] | null
  /** What Google said when it couldn't answer. */
  problem: GoogleError | null
}

/**
 * What the mail screen shows. A list costs Google three requests (labels and thread ids
 * together, then one batch for the rows and the counts); an open conversation two, and a third
 * the first time, to mark it read.
 */
export async function loadMail(
  cms: PluginContext,
  { user, searchParams }: AdminPageContext,
): Promise<MailData> {
  const found = await serviceAccounts(cms, user, 'gmail', first(searchParams.account))
  const view = viewOf(searchParams, found?.current?.id ?? '')
  const data: MailData = {
    found,
    view,
    labels: [],
    threads: [],
    next: null,
    thread: null,
    problem: null,
  }
  if (!found?.current) return data
  const box: Mailbox = { cms, userId: user.id, accountId: found.current.id }
  try {
    if (view.manage) {
      data.labels = await listLabels(box)
    } else if (view.thread) {
      const [labels, thread] = await Promise.all([listLabels(box), getThread(box, view.thread)])
      data.labels = labels
      data.thread = thread
      // Opened is read, as in Gmail itself.
      if (thread?.some((message) => message.labelIds.includes('UNREAD'))) {
        await modifyThread(box, view.thread, { remove: ['UNREAD'] })
      }
    } else {
      const page = await listMail(box, {
        label: view.label,
        q: view.q,
        pageToken: view.page || null,
      })
      data.labels = page.labels
      data.threads = page.threads
      data.next = page.next
    }
  } catch (error) {
    if (!(error instanceof GoogleError)) throw error
    data.problem = error
  }
  return data
}

type MailProps = AdminPageProps<MailData> & { cms: PluginContext }

function Labels({ cms, data }: Pick<MailProps, 'cms' | 'data'>) {
  const { view } = data
  const link = (label: string) =>
    mailPath(
      cms,
      { ...view, thread: '', show: '', page: '', q: '', manage: false, images: false },
      { label },
    )
  const current = (label: string) => !view.manage && !view.q && view.label === label
  const item = (label: MailLabel) => (
    <li key={label.id} className={current(label.id) ? 'current' : undefined}>
      <a href={link(label.id)} aria-current={current(label.id) ? 'page' : undefined}>
        {label.name}
        {label.unread ? <span className="num">{label.unread}</span> : null}
      </a>
    </li>
  )
  const system = data.labels.filter((label) => label.system)
  const own = data.labels.filter((label) => !label.system)
  return (
    <ul className="g-labels" aria-label="Labels">
      {system.slice(0, 4).map(item)}
      <li className={current(ALL_MAIL) ? 'current' : undefined}>
        <a href={link(ALL_MAIL)}>All mail</a>
      </li>
      {system.slice(4).map(item)}
      <li className="g-labels-head">Labels</li>
      {own.map(item)}
      <li className={view.manage ? 'current' : undefined}>
        <a
          href={mailPath(cms, { ...view, thread: '', show: '', page: '', q: '' }, { manage: true })}
        >
          Manage labels
        </a>
      </li>
    </ul>
  )
}

/** The fields every thread form sends: whose mailbox, and the list to go back to. */
const context = (view: View): Record<string, string> => ({
  account: view.account,
  label: view.label,
  q: view.q,
})

function ThreadList({ cms, data }: Pick<MailProps, 'cms' | 'data'>) {
  const { view } = data
  const action = (name: string) => cms.admin.actionUrl(`gmail-${name}`)
  const inTrash = view.label === 'TRASH'
  const inSpam = view.label === 'SPAM'
  const drafts = view.label === 'DRAFT' && !view.q
  const bulk: [string, string][] = drafts
    ? []
    : [
        ...(inTrash
          ? ([['untrash', 'Restore']] as [string, string][])
          : inSpam
            ? ([['not-spam', 'Not spam']] as [string, string][])
            : ([
                ['archive', 'Archive'],
                ['spam', 'Spam'],
              ] as [string, string][])),
        ['read', 'Mark as read'],
        ['unread', 'Mark as unread'],
        ...(inTrash ? [] : ([['trash', 'Move to Trash']] as [string, string][])),
      ]
  return (
    <>
      <form method="get" action={cms.admin.url('/gmail')} className="g-mail-search" role="search">
        <input type="hidden" name="account" value={view.account} />
        {view.label !== 'INBOX' && <input type="hidden" name="label" value={view.label} />}
        <label htmlFor="g-mail-q" className="screen-reader-text">
          Search mail
        </label>
        <input
          id="g-mail-q"
          type="search"
          name="q"
          defaultValue={view.q}
          maxLength={MAX_QUERY}
          placeholder="Search mail, such as from:grace has:attachment"
        />
        <button type="submit" className="button button-compact">
          Search Mail
        </button>
      </form>
      <form method="post" action={action(bulk[0]?.[0] ?? 'read')}>
        {Object.entries(context(view)).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        {bulk.length > 0 && (
          <div className="g-mail-tools">
            {bulk.map(([name, label]) => (
              <button
                key={name}
                type="submit"
                formAction={action(name)}
                className="button button-compact"
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <ListTable
          caption={drafts ? 'Drafts' : 'Conversations'}
          rows={data.threads}
          rowKey={(thread) => thread.draftId ?? thread.id}
          rowClassName={(thread) => (thread.unread ? 'g-unread' : undefined)}
          select={
            drafts
              ? undefined
              : { name: 'ids', value: (thread) => thread.id, label: (thread) => thread.subject }
          }
          columns={[
            {
              key: 'subject',
              label: drafts ? 'Draft' : 'Conversation',
              render: (thread) => (
                <>
                  <a
                    className="row-title"
                    href={
                      thread.draftId
                        ? composePath(cms, view.account, { draft: thread.draftId })
                        : mailPath(cms, view, { thread: thread.id })
                    }
                  >
                    {thread.starred ? '★ ' : ''}
                    {thread.subject}
                  </a>
                  {thread.count > 1 && <span className="num"> ({thread.count})</span>}
                  <br />
                  <span className="description">{thread.snippet}</span>
                </>
              ),
            },
            { key: 'from', label: drafts ? 'To' : 'From', render: (thread) => thread.from },
            {
              key: 'date',
              label: 'Date',
              render: (thread) => <span className="num">{when(thread.date)}</span>,
            },
          ]}
          empty={view.q ? 'No conversations match that search.' : 'Nothing here.'}
        />
      </form>
      {(view.page || data.next) && (
        <p>
          {view.page && <a href={mailPath(cms, view, { page: '' })}>← First page</a>}
          {view.page && data.next && ' · '}
          {data.next && <a href={mailPath(cms, view, { page: data.next })}>Older →</a>}
        </p>
      )}
    </>
  )
}

function Attachments({
  cms,
  account,
  message,
}: {
  cms: PluginContext
  account: string
  message: MailMessage
}) {
  if (message.attachments.length === 0) return null
  const download = (attachment: MailAttachment) =>
    `${cms.routes.apiUrl('/gmail/attachment')}?${new URLSearchParams({
      account,
      message: message.id,
      part: attachment.partId,
    })}`
  return (
    <ul className="g-attachments" aria-label="Attachments">
      {message.attachments.map((attachment) => (
        <li key={attachment.partId}>
          {attachment.filename} <span className="description num">{size(attachment.size)}</span>{' '}
          <a href={download(attachment)}>Download</a>
        </li>
      ))}
    </ul>
  )
}

function Message({
  cms,
  view,
  message,
  shown,
}: {
  cms: PluginContext
  view: View
  message: MailMessage
  /** Whether this message's formatted body is the one in the frame. */
  shown: boolean
}) {
  const frame = `${cms.routes.apiUrl('/gmail/html')}?${new URLSearchParams({
    account: view.account,
    message: message.id,
    ...(view.images ? { images: '1' } : {}),
  })}`
  const draft = message.labelIds.includes('DRAFT')
  return (
    <section className="g-message" aria-label={`Message from ${message.from}`}>
      <header>
        <div>
          <strong>{message.from || '(unknown sender)'}</strong>
          <br />
          <span className="g-to">
            to {message.to || '(nobody)'}
            {message.cc ? `, cc ${message.cc}` : ''}
          </span>
        </div>
        <span className="description num">{when(message.date)}</span>
      </header>
      {shown && message.hasHtml ? (
        <>
          {/* The message's own HTML, in a frame with no scripts and no origin of this site. */}
          <iframe
            className="g-mail-frame"
            title={`The message from ${message.from}`}
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            src={frame}
          />
          <p className="description">
            {view.images ? (
              <a href={mailPath(cms, view, { images: false, show: message.id })}>
                Hide pictures from the web
              </a>
            ) : (
              <>
                Pictures from the web aren’t shown, so the sender can’t tell the message was opened.{' '}
                <a href={mailPath(cms, view, { images: true, show: message.id })}>Show pictures</a>
              </>
            )}
          </p>
        </>
      ) : (
        <>
          <pre className="g-mail-text">{message.text ?? message.snippet}</pre>
          {message.hasHtml && (
            <p className="description">
              <a href={mailPath(cms, view, { show: message.id, images: false })}>
                Show the formatted message
              </a>
            </p>
          )}
        </>
      )}
      <Attachments cms={cms} account={view.account} message={message} />
      <p className="g-mail-tools">
        {draft ? (
          <a
            className="button button-compact"
            href={mailPath(cms, view, { label: 'DRAFT', thread: '' })}
          >
            Open in Drafts
          </a>
        ) : (
          <>
            <a
              className="button button-compact"
              href={composePath(cms, view.account, { reply: message.id })}
            >
              Reply
            </a>
            <a
              className="button button-compact"
              href={composePath(cms, view.account, { replyAll: message.id })}
            >
              Reply to all
            </a>
            <a
              className="button button-compact"
              href={composePath(cms, view.account, { forward: message.id })}
            >
              Forward
            </a>
          </>
        )}
      </p>
    </section>
  )
}

function Thread({ cms, data }: Pick<MailProps, 'cms' | 'data'>) {
  const { view } = data
  const messages = data.thread ?? []
  const action = (name: string) => cms.admin.actionUrl(`gmail-${name}`)
  const fields = { ...context(view), id: view.thread }
  const labels = new Set(messages.flatMap((message) => message.labelIds))
  const shown = messages.find((message) => message.id === view.show)?.id ?? messages.at(-1)?.id
  const own = data.labels.filter((label) => !label.system)
  const button = (name: string, label: string, variant?: 'delete') => (
    <FormButton
      key={name}
      action={action(name)}
      fields={fields}
      variant={variant}
      className="inline-form"
    >
      {label}
    </FormButton>
  )
  return (
    <div className="g-thread">
      <p>
        <a href={mailPath(cms, view, { thread: '', show: '', images: false })}>
          ← Back to the list
        </a>
      </p>
      <h2>{messages[0]?.subject || '(no subject)'}</h2>
      <div className="g-mail-tools">
        {labels.has('TRASH')
          ? button('untrash', 'Restore from Trash')
          : labels.has('SPAM')
            ? button('not-spam', 'Not spam')
            : [labels.has('INBOX') ? button('archive', 'Archive') : null, button('spam', 'Spam')]}
        {button('unread', 'Mark as unread')}
        {labels.has('STARRED') ? button('unstar', 'Remove star') : button('star', 'Star')}
        {!labels.has('TRASH') && button('trash', 'Move to Trash', 'delete')}
      </div>
      {own.length > 0 && (
        <form method="post" action={action('label-add')} className="g-label-row">
          {Object.entries(fields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <label htmlFor="g-apply">Label</label>
          <select id="g-apply" name="apply">
            {own.map((label) => (
              <option key={label.id} value={label.id}>
                {label.name}
                {labels.has(label.id) ? ' (applied)' : ''}
              </option>
            ))}
          </select>
          <button type="submit" className="button button-compact">
            Apply
          </button>
          <button
            type="submit"
            formAction={action('label-remove')}
            className="button button-compact"
          >
            Remove
          </button>
        </form>
      )}
      {messages.map((message) => (
        <Message
          key={message.id}
          cms={cms}
          view={view}
          message={message}
          shown={message.id === shown}
        />
      ))}
    </div>
  )
}

function ManageLabels({ cms, data }: Pick<MailProps, 'cms' | 'data'>) {
  const { view } = data
  const action = (name: string) => cms.admin.actionUrl(`gmail-label-${name}`)
  const own = data.labels.filter((label) => !label.system)
  return (
    <div className="g-thread">
      <h2>Labels</h2>
      {own.length === 0 && <p>You have no labels of your own yet.</p>}
      {own.map((label) => (
        <div key={label.id} className="g-label-row">
          <form method="post" action={action('rename')} className="g-label-row">
            <input type="hidden" name="account" value={view.account} />
            <input type="hidden" name="id" value={label.id} />
            <label htmlFor={`g-label-${label.id}`} className="screen-reader-text">
              Name of the label {label.name}
            </label>
            <input
              id={`g-label-${label.id}`}
              type="text"
              name="name"
              defaultValue={label.name}
              maxLength={100}
              className="regular-text"
              required
            />
            <button type="submit" className="button button-compact">
              Rename
            </button>
          </form>
          <FormButton
            action={action('delete')}
            fields={{ account: view.account, id: label.id }}
            variant="delete"
            className="inline-form"
          >
            Delete
          </FormButton>
        </div>
      ))}
      <p className="description">
        Deleting a label leaves its conversations where they are: they only lose the label.
      </p>
      <form method="post" action={action('create')} className="g-label-row">
        <input type="hidden" name="account" value={view.account} />
        <label htmlFor="g-label-new">New label</label>
        <input
          id="g-label-new"
          type="text"
          name="name"
          maxLength={100}
          className="regular-text"
          required
        />
        <button type="submit" className="button button-compact">
          Add Label
        </button>
      </form>
    </div>
  )
}

export function MailScreen({ cms, data }: MailProps) {
  const { found, view } = data
  if (!found) return <Notice type="warning">Gmail is switched off under Google › Settings.</Notice>
  const here = cms.admin.url('/gmail')
  if (!found.current) {
    return (
      <>
        <GoogleStyles />
        <NoAccount cms={cms} found={found} here={here} />
      </>
    )
  }
  const reconnect = `${cms.routes.apiUrl('/oauth/start')}?${new URLSearchParams({
    service: 'gmail',
    account: found.current.id,
    next: here,
  })}`
  return (
    <>
      <GoogleStyles />
      <MailStyles />
      <AccountSwitch
        label="Account"
        action={here}
        accounts={found.accounts}
        current={found.current.id}
      />
      {data.problem && <GoogleProblem error={data.problem} reconnect={reconnect} />}
      <div className="g-mail">
        <Labels cms={cms} data={data} />
        <div>
          {view.manage ? (
            <ManageLabels cms={cms} data={data} />
          ) : view.thread ? (
            data.thread ? (
              <Thread cms={cms} data={data} />
            ) : (
              !data.problem && (
                <Notice type="warning">
                  <p>
                    That conversation is no longer there.{' '}
                    <a href={mailPath(cms, view, { thread: '', show: '' })}>Back to the list</a>
                  </p>
                </Notice>
              )
            )
          ) : (
            <ThreadList cms={cms} data={data} />
          )}
        </div>
      </div>
    </>
  )
}

// ── Writing ────────────────────────────────────────────────────────────────────

export interface Prefill {
  to: string
  cc: string
  bcc: string
  subject: string
  body: string
  /** The message being answered, which the message joins the conversation of. */
  reply: string
  draft: string
  /** The message whose attachments can be carried over: the draft's, or the forwarded one's. */
  source: string
  attachments: MailAttachment[]
}

const EMPTY: Prefill = {
  to: '',
  cc: '',
  bcc: '',
  subject: '',
  body: '',
  reply: '',
  draft: '',
  source: '',
  attachments: [],
}

const prefixed = (prefix: 'Re' | 'Fwd', subject: string): string =>
  new RegExp(`^${prefix}:`, 'i').test(subject.trim())
    ? subject.trim()
    : `${prefix}: ${subject.trim()}`

const quoted = (message: MailMessage): string =>
  (message.text ?? message.snippet)
    .slice(0, MAX_QUOTED)
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n')

/** An answer to a message: to its sender, or to everyone on it but the person answering. */
export function replyPrefill(message: MailMessage, all: boolean, own: readonly string[]): Prefill {
  const mine = (entry: string) => own.includes(addressOf(entry))
  const sender = message.replyTo || message.from
  const others = all ? splitList(message.to).filter((entry) => !mine(entry)) : []
  const to = [...splitList(sender), ...others].filter(
    (entry, index, entries) =>
      entries.findIndex((other) => addressOf(other) === addressOf(entry)) === index,
  )
  const cc = all
    ? splitList(message.cc).filter(
        (entry) => !mine(entry) && !to.some((other) => addressOf(other) === addressOf(entry)),
      )
    : []
  return {
    ...EMPTY,
    to: to.join(', '),
    cc: cc.join(', '),
    subject: prefixed('Re', message.subject),
    body: `\n\nOn ${when(message.date)}, ${message.from} wrote:\n${quoted(message)}`,
    reply: message.id,
  }
}

/** A message passed on: its text below a note of where it came from, its attachments on offer. */
export function forwardPrefill(message: MailMessage): Prefill {
  return {
    ...EMPTY,
    subject: prefixed('Fwd', message.subject),
    body: [
      '',
      '',
      '---------- Forwarded message ----------',
      `From: ${message.from}`,
      `Date: ${when(message.date)}`,
      `Subject: ${message.subject}`,
      `To: ${message.to}`,
      '',
      (message.text ?? message.snippet).slice(0, MAX_QUOTED),
    ].join('\n'),
    source: message.id,
    attachments: message.attachments,
  }
}

export interface ComposeData {
  found: ServiceAccounts | null
  heading: string
  senders: SendAs[]
  prefill: Prefill
  problem: GoogleError | null
  /** The message or draft the address named is gone. */
  missing: boolean
}

/** What the writing screen starts with: the addresses to send from, and what it answers. */
export async function loadCompose(
  cms: PluginContext,
  { user, searchParams }: AdminPageContext,
): Promise<ComposeData> {
  const found = await serviceAccounts(cms, user, 'gmail', first(searchParams.account))
  const pick = (name: string) => {
    const value = first(searchParams[name])
    return GMAIL_ID.test(value) ? value : ''
  }
  const [reply, replyAll, forward, draft] = [
    pick('reply'),
    pick('replyAll'),
    pick('forward'),
    pick('draft'),
  ]
  const data: ComposeData = {
    found,
    heading: draft
      ? 'Edit draft'
      : reply || replyAll
        ? 'Reply'
        : forward
          ? 'Forward'
          : 'New message',
    senders: [],
    prefill: EMPTY,
    problem: null,
    missing: false,
  }
  if (!found?.current) return data
  const box: Mailbox = { cms, userId: user.id, accountId: found.current.id }
  const source = reply || replyAll || forward
  try {
    const [senders, message] = await Promise.all([
      listSendAs(box),
      draft ? getDraft(box, draft) : source ? getMessage(box, source) : null,
    ])
    data.senders = senders
    if ((draft || source) && !message) {
      data.missing = true
    } else if (message && draft) {
      data.prefill = {
        ...EMPTY,
        to: message.to,
        cc: message.cc,
        subject: message.subject,
        body: message.text ?? '',
        draft,
        source: message.id,
        attachments: message.attachments,
      }
    } else if (message) {
      data.prefill = forward
        ? forwardPrefill(message)
        : replyPrefill(
            message,
            Boolean(replyAll),
            senders.map((sender) => sender.email),
          )
    }
  } catch (error) {
    if (!(error instanceof GoogleError)) throw error
    data.problem = error
  }
  return data
}

export function ComposeScreen({ cms, data }: AdminPageProps<ComposeData> & { cms: PluginContext }) {
  const { found, prefill } = data
  if (!found) return <Notice type="warning">Gmail is switched off under Google › Settings.</Notice>
  const here = cms.admin.url('/gmail/compose')
  if (!found.current) {
    return (
      <>
        <GoogleStyles />
        <NoAccount cms={cms} found={found} here={here} />
      </>
    )
  }
  const account = found.current
  const action = (name: string) => cms.admin.actionUrl(`gmail-${name}`)
  const inbox = `${cms.admin.url('/gmail')}?${new URLSearchParams({ account: account.id })}`
  const senders =
    data.senders.length > 0
      ? data.senders
      : [{ email: account.email, name: account.name, primary: true }]
  return (
    <>
      <GoogleStyles />
      <MailStyles />
      <p>
        <a href={inbox}>← Inbox</a>
      </p>
      {data.problem && <GoogleProblem error={data.problem} />}
      {data.missing && (
        <Notice type="warning">
          The message this was about is no longer there. This is a new message.
        </Notice>
      )}
      <form
        method="post"
        action={action('send')}
        encType="multipart/form-data"
        className="g-compose"
      >
        <input type="hidden" name="account" value={account.id} />
        {prefill.reply && <input type="hidden" name="reply" value={prefill.reply} />}
        {prefill.draft && <input type="hidden" name="draft" value={prefill.draft} />}
        {prefill.source && <input type="hidden" name="source" value={prefill.source} />}
        <div className="g-line">
          <label htmlFor="g-from">From</label>
          <select
            id="g-from"
            name="from"
            defaultValue={senders.find((sender) => sender.primary)?.email}
          >
            {senders.map((sender) => (
              <option key={sender.email} value={sender.email}>
                {sender.name ? `${sender.name} <${sender.email}>` : sender.email}
              </option>
            ))}
          </select>
        </div>
        <div className="g-line">
          <label htmlFor="g-to">To</label>
          <input id="g-to" type="text" name="to" defaultValue={prefill.to} autoComplete="off" />
        </div>
        <div className="g-line">
          <label htmlFor="g-cc">Cc</label>
          <input id="g-cc" type="text" name="cc" defaultValue={prefill.cc} autoComplete="off" />
        </div>
        <div className="g-line">
          <label htmlFor="g-bcc">Bcc</label>
          <input id="g-bcc" type="text" name="bcc" defaultValue={prefill.bcc} autoComplete="off" />
        </div>
        <div className="g-line">
          <label htmlFor="g-subject">Subject</label>
          <input
            id="g-subject"
            type="text"
            name="subject"
            defaultValue={prefill.subject}
            maxLength={500}
          />
        </div>
        <label htmlFor="g-body" className="screen-reader-text">
          Message
        </label>
        <textarea id="g-body" name="body" defaultValue={prefill.body} />
        {prefill.attachments.length > 0 && (
          <fieldset>
            <legend>{prefill.draft ? 'Attached to this draft' : 'Attached to the original'}</legend>
            {prefill.attachments.map((attachment) => (
              <label key={attachment.partId} style={{ display: 'block' }}>
                <input type="checkbox" name="keep" value={attachment.partId} defaultChecked />{' '}
                {attachment.filename}{' '}
                <span className="description num">{size(attachment.size)}</span>
              </label>
            ))}
          </fieldset>
        )}
        <div className="g-line">
          <label htmlFor="g-files">Attach</label>
          <input id="g-files" type="file" name="files" multiple />
        </div>
        <p className="description">Attachments can come to 10 MB at most, up to ten files.</p>
        <div className="g-acts">
          <button type="submit" className="button button-primary">
            Send
          </button>
          <button type="submit" formAction={action('draft-save')} className="button">
            Save draft
          </button>
          {prefill.draft && (
            <button
              type="submit"
              formAction={action('draft-delete')}
              formNoValidate
              className="button button-link-delete"
            >
              Discard draft
            </button>
          )}
        </div>
        <p className="description">
          Sent from your Gmail account: it appears in your Sent mail. Separate addresses with
          commas.
        </p>
      </form>
    </>
  )
}
