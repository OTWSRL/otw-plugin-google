import { describe, expect, it } from 'vitest'
import { listAccounts } from '../src/accounts'
import { getMessage, type Mailbox } from '../src/services/gmail/client'
import { forwardPrefill, replyPrefill } from '../src/services/gmail/screens'
import { fakeGmail, type FakeMailbox } from './fake-gmail.mjs'
import { bootGoogle } from './fixtures'

async function mailSite() {
  const site = await bootGoogle({ routes: [fakeGmail] })
  const ada = await site.person('ada@gmail.com')
  expect((await site.connect(ada, 'ada', { service: 'gmail' })).outcome).toBe('connected')
  const [account] = await listAccounts(site.cms(), ada.user.id)
  const box: Mailbox = { cms: site.cms(), userId: ada.user.id, accountId: account!.id }
  const mail = () => (site.fake.data.gmail as Record<string, FakeMailbox>).ada!
  const gmailCalls = () =>
    site.fake.requests.filter((request) => request.host === 'gmail.googleapis.com').length
  const screen = (query: Record<string, string> = {}, path = '') =>
    site.screen(`/admin/google/gmail${path}`, ada.user, { account: account!.id, ...query })
  return { site, ada, account: account!.id, box, mail, screen, gmailCalls }
}

describe('the mail screen', () => {
  it('lists a label’s conversations with the labels, a search, and buttons for the ticked ones', async () => {
    const { screen, account, gmailCalls } = await mailSite()
    const before = gmailCalls()
    const { html, title } = await screen()
    expect(gmailCalls() - before).toBe(3)
    expect(title).toBe('Gmail')
    expect(html).toContain(
      `<a class="row-title" href="/admin/google/gmail?account=${account}&amp;thread=t1">★ Episode 12 thumbnail</a>`,
    )
    expect(html).toContain('<span class="num"> (3)</span>')
    expect(html).toContain('Grace Hopper, me')
    // Unread rows are marked, and the labels carry their counts.
    expect(html).toContain('class="g-unread"')
    expect(html).toMatch(/Inbox<span class="num">3<\/span>/)
    expect(html).toMatch(/Clients<span class="num">1<\/span>/)
    expect(html).toContain(`href="/admin/google/gmail?account=${account}&amp;label=all"`)
    expect(html).toContain('name="ids" value="t1"')
    for (const name of ['archive', 'spam', 'read', 'unread', 'trash']) {
      expect(html).toContain(`formAction="/api/p/google/actions/gmail-${name}"`)
    }
    expect(html).toContain(`<input type="hidden" name="account" value="${account}"/>`)
    expect(html).toContain(`href="/admin/google/gmail?account=${account}&amp;page=15">Older →</a>`)
    // Nothing of a message's own markup is in the page, and no script at all.
    expect(html).not.toMatch(/<script|steal\(|evil\.test\/pixel/i)
    expect(html).not.toContain('<iframe')
  })

  it('offers Restore in Trash, Not spam in Spam, and searches within the label', async () => {
    const { screen } = await mailSite()
    const trash = (await screen({ label: 'TRASH' })).html
    expect(trash).toContain('gmail-untrash')
    expect(trash).not.toContain('gmail-trash"')
    expect(trash).toContain('Old plans')
    expect(trash).toContain('<input type="hidden" name="label" value="TRASH"/>')
    const spam = (await screen({ label: 'SPAM' })).html
    expect(spam).toContain('gmail-not-spam')
    const none = (await screen({ q: 'no such words anywhere' })).html
    expect(none).toContain('No conversations match that search.')
    expect(none).toContain('value="no such words anywhere"')
    // A label that isn't one, and a search of any length, fall back or are cut: nothing breaks.
    expect((await screen({ label: '../x', q: 'x'.repeat(2000) })).html).toContain(
      `value="${'x'.repeat(500)}"`,
    )
  })

  it('takes an id from the address only in the shape Gmail’s ids have', async () => {
    const { site, screen } = await mailSite()
    const seen = site.fake.requests.length
    // None of these names a thread, a page or a message: the list is shown as if they weren't there.
    const { html } = await screen({
      thread: '../labels',
      page: 'a b',
      show: '<x>',
      label: 'IN BOX',
    })
    expect(html).toContain('Episode 12 thumbnail')
    expect(html).toContain('name="ids" value="t1"')
    const compose = await screen({ reply: '../labels', draft: 'd 1' }, '/compose')
    expect(compose.title).toBe('New message')
    expect(compose.html).not.toContain('name="reply"')
    expect(compose.html).not.toContain('The message this was about')
    const paths = site.fake.requests
      .slice(seen)
      .map((request) => `${request.method} ${request.path}${request.query}`)
    expect(paths.sort()).toEqual([
      'GET /gmail/v1/users/me/labels',
      'GET /gmail/v1/users/me/settings/sendAs',
      'GET /gmail/v1/users/me/threads?maxResults=15&labelIds=INBOX',
      'POST /batch/gmail/v1',
    ])
  })

  it('lists drafts as links into the writing screen, with nothing to tick', async () => {
    const { screen, account } = await mailSite()
    const { html } = await screen({ label: 'DRAFT' })
    expect(html).toContain(`href="/admin/google/gmail/compose?account=${account}&amp;draft=d1"`)
    expect(html).not.toContain('name="ids"')
  })

  it('opens a conversation in two requests, a third to mark it read, with its HTML in a sandboxed frame', async () => {
    const { screen, account, gmailCalls, mail } = await mailSite()
    const before = gmailCalls()
    const { html } = await screen({ thread: 't1' })
    expect(gmailCalls() - before).toBe(3)
    expect(mail().messages.find((message) => message.id === 'm3')!.labelIds).not.toContain('UNREAD')
    // Read already: two requests from now on.
    const again = gmailCalls()
    await screen({ thread: 't1' })
    expect(gmailCalls() - again).toBe(2)

    expect(html).toContain('<h2>Episode 12 thumbnail</h2>')
    // Earlier messages show their text; the last shows its formatted body, in a frame.
    expect(html).toContain('<pre class="g-mail-text">First version attached. Too much text?</pre>')
    expect(html).toContain(
      `<iframe class="g-mail-frame" title="The message from Grace Hopper &lt;grace@example.com&gt;" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" src="/api/p/google/gmail/html?account=${account}&amp;message=m3"></iframe>`,
    )
    expect(html.match(/<iframe/g)).toHaveLength(1)
    expect(html).not.toContain('<b>second version</b>')
    expect(html).toContain(
      `href="/api/p/google/gmail/attachment?account=${account}&amp;message=m3&amp;part=1">Download</a>`,
    )
    expect(html).toContain('thumbnail-v2.png')
    expect(html).toContain(`href="/admin/google/gmail/compose?account=${account}&amp;reply=m3"`)
    expect(html).toContain(`href="/admin/google/gmail/compose?account=${account}&amp;replyAll=m3"`)
    expect(html).toContain(`href="/admin/google/gmail/compose?account=${account}&amp;forward=m3"`)
    for (const name of ['archive', 'spam', 'unread', 'unstar', 'trash', 'label-add']) {
      expect(html).toContain(`action="/api/p/google/actions/gmail-${name}"`)
    }
    expect(html).toContain('<option value="Label_1">Clients (applied)</option>')
    expect(html).toContain('<input type="hidden" name="id" value="t1"/>')
    // Pictures stay off until asked for, by a link that reloads the screen.
    expect(html).toContain(
      `href="/admin/google/gmail?account=${account}&amp;thread=t1&amp;show=m3&amp;images=1">Show pictures</a>`,
    )
    const pictures = (await screen({ thread: 't1', show: 'm3', images: '1' })).html
    expect(pictures).toContain(
      `src="/api/p/google/gmail/html?account=${account}&amp;message=m3&amp;images=1"`,
    )
  })

  it('never puts a hostile message’s markup in the page: it goes to the frame alone', async () => {
    const { screen } = await mailSite()
    const { html } = await screen({ thread: 't3' })
    expect(html).toContain('<h2>Security alert</h2>')
    expect(html.match(/<iframe/g)).toHaveLength(1)
    expect(html).not.toMatch(
      /<script|steal\(|onclick|onerror|evil\.test\/login|<form action="https/i,
    )
  })

  it('writes a sender’s name and a subject as text, whatever they hold', async () => {
    const { screen, mail } = await mailSite()
    mail().messages.find((message) => message.id === 'm4')!.headers.From =
      '"<img src=x onerror=alert(1)>" <x@evil.test>'
    mail().messages.find((message) => message.id === 'm4')!.headers.Subject =
      '<script>alert(1)</script>'
    const list = (await screen({ label: 'Label_2' })).html
    expect(list).not.toMatch(/<script>|<img src=x/)
    expect(list).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    const thread = (await screen({ thread: 't2' })).html
    expect(thread).not.toMatch(/<script>|<img src=x/)
  })

  it('says so when the conversation is gone, and when Google ends the connection', async () => {
    const { site, screen, account } = await mailSite()
    expect((await screen({ thread: 'gone' })).html).toContain(
      'That conversation is no longer there.',
    )
    site.fake.revoke('ada')
    const { html } = await screen()
    expect(html).toContain('Google ended this connection. Connect the account again.')
    expect(html).toContain(
      `service=gmail&amp;account=${account}&amp;next=%2Fadmin%2Fgoogle%2Fgmail">Connect it again</a>`,
    )
  })

  it('manages the person’s own labels', async () => {
    const { screen, account } = await mailSite()
    const { html } = await screen({ manage: 'labels' })
    expect(html).toContain('action="/api/p/google/actions/gmail-label-rename"')
    expect(html).toContain('action="/api/p/google/actions/gmail-label-delete"')
    expect(html).toContain('action="/api/p/google/actions/gmail-label-create"')
    expect(html).toContain('value="Clients"')
    expect(html).toContain(`<input type="hidden" name="account" value="${account}"/>`)
    // Gmail's own labels aren't offered for renaming.
    expect(html).not.toContain('value="INBOX"')
  })

  it('asks for Gmail’s permission when no account has given it, and shows another person nothing', async () => {
    const site = await bootGoogle({ routes: [fakeGmail] })
    const ada = await site.person('ada@gmail.com')
    const nothing = (await site.screen('/admin/google/gmail', ada.user)).html
    expect(nothing).toContain('Connect a Google account to use Gmail here.')
    await site.connect(ada, 'ada')
    const [account] = await listAccounts(site.cms(), ada.user.id)
    const { html } = await site.screen('/admin/google/gmail', ada.user)
    expect(html).toContain('None of your Google accounts has allowed Gmail yet.')
    expect(html).toContain(
      `service=gmail&amp;next=%2Fadmin%2Fgoogle%2Fgmail&amp;account=${account!.id}`,
    )
    // Someone else naming Ada's account sees their own empty state, and Gmail isn't asked.
    await site.connect(ada, 'ada', { service: 'gmail', account: account!.id })
    const eve = await site.person('eve@cms.test', 'editor')
    const theirs = (
      await site.screen('/admin/google/gmail', eve.user, { account: account!.id, thread: 't1' })
    ).html
    expect(theirs).toContain('Connect a Google account to use Gmail here.')
    expect(theirs).not.toContain('Episode 12')
    expect(site.fake.requests.filter((request) => request.host === 'gmail.googleapis.com')).toEqual(
      [],
    )
    const customer = await site.person('c@cms.test', 'customer')
    expect((await site.screen('/admin/google/gmail', customer.user)).kind).toBe('forbidden')
  })
})

describe('the writing screen', () => {
  it('starts empty, sending from the account’s own address or a verified alias', async () => {
    const { screen, account } = await mailSite()
    const { html, title } = await screen({}, '/compose')
    expect(title).toBe('New message')
    expect(html).toContain(
      'action="/api/p/google/actions/gmail-send" encType="multipart/form-data"',
    )
    expect(html).toContain('formAction="/api/p/google/actions/gmail-draft-save"')
    expect(html).toContain(`<input type="hidden" name="account" value="${account}"/>`)
    expect(html).toContain(
      '<option value="ada@gmail.com" selected="">Ada Lovelace &lt;ada@gmail.com&gt;</option>',
    )
    expect(html).toContain(
      '<option value="support@example.com">Ada, Support &lt;support@example.com&gt;</option>',
    )
    expect(html).not.toContain('pending@example.com')
    expect(html).not.toContain('name="reply"')
    expect(html).toContain('<input id="g-files" type="file" multiple="" name="files"/>')
  })

  it('answers the sender, or everyone but the person answering, quoting the message', async () => {
    const { screen, box } = await mailSite()
    const reply = await screen({ reply: 'm3' }, '/compose')
    expect(reply.title).toBe('Reply')
    expect(reply.html).toContain('<input type="hidden" name="reply" value="m3"/>')
    expect(reply.html).toContain('name="to" value="Grace Hopper &lt;grace@example.com&gt;"')
    expect(reply.html).toContain('name="subject" value="Re: Episode 12 thumbnail"')
    expect(reply.html).toContain('&gt; Hi Ada,')

    const message = (await getMessage(box, 'm3'))!
    const own = ['ada@gmail.com', 'support@example.com']
    expect(replyPrefill(message, false, own)).toMatchObject({
      to: 'Grace Hopper <grace@example.com>',
      cc: '',
    })
    // Everyone on the message, without the person's own addresses, and nobody twice.
    expect(replyPrefill(message, true, own)).toMatchObject({
      to: 'Grace Hopper <grace@example.com>',
      cc: 'Linus Example <linus@example.com>',
      reply: 'm3',
    })
    expect(replyPrefill({ ...message, replyTo: 'list@example.com' }, false, own).to).toBe(
      'list@example.com',
    )
    expect(replyPrefill({ ...message, subject: 'Hello' }, false, own).subject).toBe('Re: Hello')
  })

  it('passes a message on with its attachments on offer, and reopens a draft with its own', async () => {
    const { screen, box } = await mailSite()
    const forward = await screen({ forward: 'm3' }, '/compose')
    expect(forward.title).toBe('Forward')
    expect(forward.html).toContain('name="subject" value="Fwd: Re: Episode 12 thumbnail"')
    expect(forward.html).toContain('---------- Forwarded message ----------')
    expect(forward.html).toContain('<input type="hidden" name="source" value="m3"/>')
    expect(forward.html).toContain('<input type="checkbox" name="keep" checked="" value="1"/>')
    expect(forward.html).not.toContain('name="reply"')
    expect(forwardPrefill((await getMessage(box, 'm3'))!).to).toBe('')

    const draft = await screen({ draft: 'd1' }, '/compose')
    expect(draft.title).toBe('Edit draft')
    expect(draft.html).toContain('<input type="hidden" name="draft" value="d1"/>')
    expect(draft.html).toContain('<input type="hidden" name="source" value="md1"/>')
    expect(draft.html).toContain('name="to" value="Katherine J. &lt;katherine@example.com&gt;"')
    expect(draft.html).toContain('I left comments on the second page.')
    expect(draft.html).toContain('plan.txt')
    expect(draft.html).toContain('formAction="/api/p/google/actions/gmail-draft-delete"')

    const gone = await screen({ reply: 'no-such-message' }, '/compose')
    expect(gone.html).toContain('The message this was about is no longer there.')
    expect(gone.html).not.toContain('name="reply"')
  })
})
