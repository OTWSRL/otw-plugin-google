import { describe, expect, it } from 'vitest'
import { listAccounts } from '../src/accounts'
import { MAX_ATTACHED_BYTES, recipients, THREAD_CHANGES } from '../src/services/gmail/actions'
import { THREAD_ACTIONS } from '../src/services/gmail/admin'
import { frameSecurity } from '../src/services/gmail/api'
import {
  ALL_MAIL,
  decodeHeader,
  getAttachment,
  getDraft,
  getHtml,
  getThread,
  listMail,
  listSendAs,
  MAX_ATTACHMENT_BYTES,
  PAGE_SIZE,
  type Mailbox,
} from '../src/services/gmail/client'
import { fakeGmail, type FakeMailbox } from './fake-gmail.mjs'
import { bootGoogle, type BootOptions, type GoogleSite, type Person } from './fixtures'

const ORIGIN = 'http://cms.test'

/** A site where Ada has connected her Google account and allowed Gmail. */
async function mailSite(options: BootOptions = {}) {
  const site = await bootGoogle({ routes: [fakeGmail], ...options })
  const ada = await site.person('ada@gmail.com')
  expect((await site.connect(ada, 'ada', { service: 'gmail' })).outcome).toBe('connected')
  const cms = site.cms()
  const [account] = await listAccounts(cms, ada.user.id)
  const box: Mailbox = { cms, userId: ada.user.id, accountId: account!.id }
  const mail = (who = 'ada') => (site.fake.data.gmail as Record<string, FakeMailbox>)[who]!
  /** The requests Gmail got since the last look, as `METHOD path`. */
  let seen = site.fake.requests.length
  const asked = () => {
    const made = site.fake.requests
      .slice(seen)
      .filter((request) => request.host === 'gmail.googleapis.com')
      .map((request) => `${request.method} ${request.path}`)
    seen = site.fake.requests.length
    return made
  }
  asked()
  const labelsOf = (threadId: string) =>
    [
      ...new Set(
        mail()
          .messages.filter((message) => message.threadId === threadId)
          .flatMap((message) => message.labelIds),
      ),
    ].sort()
  return { site, ada, cms, box, account: account!.id, mail, asked, labelsOf }
}

type Fields = [string, string | File][]

/** Posts one of Gmail's forms as a browser would, files and repeated fields included. */
async function post(
  site: GoogleSite,
  who: Person | null,
  name: string,
  fields: Fields,
  multipart = false,
) {
  let body: FormData | URLSearchParams
  if (multipart) {
    body = new FormData()
    for (const [key, value] of fields) body.append(key, value)
  } else {
    body = new URLSearchParams(fields as [string, string][])
  }
  const response = await site.kernel.handleApi(
    new Request(`${ORIGIN}/api/p/google/actions/gmail-${name}`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        referer: `${ORIGIN}/admin/google/gmail`,
        ...(who ? { cookie: who.cookie } : {}),
      },
      body,
    }),
  )
  const location = new URL(response.headers.get('location') ?? '/', ORIGIN)
  const flash = site.kernel.readFlash(location.searchParams.get('flash') ?? undefined)
  location.searchParams.delete('flash')
  return { status: response.status, path: location.pathname + location.search, flash }
}

const sentText = (mime: string) => {
  const [, body = ''] = mime.split('\r\n\r\n')
  // A browser sends a textarea's line breaks as CRLF, and so does the test's form.
  return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8').replace(/\r\n/g, '\n')
}
const header = (mime: string, name: string) =>
  new RegExp(`^${name}: (.*)$`, 'm').exec(mime.split('\r\n\r\n')[0]!)?.[1] ?? null

describe('a list of mail', () => {
  it('costs three requests: labels and thread ids, then one batch for the rows and the counts', async () => {
    const { box, asked } = await mailSite()
    const page = await listMail(box, { label: 'INBOX', q: '', pageToken: null })
    expect(asked().sort()).toEqual([
      'GET /gmail/v1/users/me/labels',
      'GET /gmail/v1/users/me/threads',
      'POST /batch/gmail/v1',
    ])
    expect(page.threads).toHaveLength(PAGE_SIZE)
    expect(page.next).toBe(String(PAGE_SIZE))
    expect(page.threads[0]).toMatchObject({
      id: 't1',
      subject: 'Episode 12 thumbnail',
      from: 'Grace Hopper, me',
      count: 3,
      unread: true,
      starred: true,
      snippet: 'Hi Ada, Here is the second version. The title is larger. Grace',
    })
    expect(page.threads[0]!.date).toBeInstanceOf(Date)
    expect(page.threads.find((thread) => thread.id === 't2')).toMatchObject({
      subject: 'Invoice 2026-118',
      from: 'Linus Example',
      unread: true,
      starred: false,
    })
    // A subject Gmail hands over still encoded is read.
    expect(page.threads.find((thread) => thread.id === 't7')!.subject).toBe(
      'Long newsletter – overview',
    )
    // Gmail's own labels in the order people know, then the person's by name, with counts.
    expect(page.labels.map((label) => [label.id, label.name, label.unread])).toEqual([
      ['INBOX', 'Inbox', 3],
      ['STARRED', 'Starred', null],
      ['SENT', 'Sent', null],
      ['DRAFT', 'Drafts', 1],
      ['SPAM', 'Spam', 0],
      ['TRASH', 'Trash', null],
      ['Label_1', 'Clients', 1],
      ['Label_2', 'Invoices', 1],
    ])
  })

  it('pages, searches with Gmail’s own words, and keeps Spam and Trash out of All mail', async () => {
    const { box } = await mailSite()
    const second = await listMail(box, { label: 'INBOX', q: '', pageToken: String(PAGE_SIZE) })
    expect(second.threads.length).toBeGreaterThan(0)
    expect(second.next).toBeNull()
    const found = await listMail(box, { label: ALL_MAIL, q: 'from:linus', pageToken: null })
    expect(found.threads.map((thread) => thread.id)).toEqual(['t2'])
    const trash = await listMail(box, { label: 'TRASH', q: '', pageToken: null })
    expect(trash.threads.map((thread) => thread.id)).toEqual(['t5'])
    const all = await listMail(box, { label: ALL_MAIL, q: '', pageToken: null })
    expect(all.threads.map((thread) => thread.id)).not.toContain('t4')
    expect(all.threads.map((thread) => thread.id)).not.toContain('t5')
  })

  it('lists drafts by their own ids, each opening for writing', async () => {
    const { box } = await mailSite()
    const drafts = await listMail(box, { label: 'DRAFT', q: '', pageToken: null })
    expect(drafts.threads).toEqual([
      expect.objectContaining({ id: 'md1', draftId: 'd1', subject: 'Draft of the launch plan' }),
    ])
  })

  it('reads the rows one by one when the batch address fails or answers nonsense', async () => {
    for (const broken of [true, 'garbled'] as const) {
      const { box, mail, asked } = await mailSite()
      const whole = await listMail(box, { label: 'INBOX', q: '', pageToken: null })
      asked()
      mail().batchBroken = broken
      const page = await listMail(box, { label: 'INBOX', q: '', pageToken: null })
      expect(page).toEqual(whole)
      expect(
        asked().filter((line) => line.startsWith('GET /gmail/v1/users/me/threads/')),
      ).toHaveLength(PAGE_SIZE)
    }
  })

  it('leaves out a thread that went away between the list and the reading of it', async () => {
    const { box, mail } = await mailSite()
    const original = mail().messages
    // The list still names t2; by the time it's described, its message is gone.
    let reads = 0
    Object.defineProperty(mail(), 'messages', {
      configurable: true,
      get: () => (++reads > 1 ? original.filter((message) => message.threadId !== 't2') : original),
    })
    const page = await listMail(box, { label: 'Label_2', q: '', pageToken: null })
    expect(page.threads).toEqual([])
  })
})

describe('a thread', () => {
  it('comes whole in one request: each message’s people, text and attachments', async () => {
    const { box, asked } = await mailSite()
    const messages = (await getThread(box, 't1'))!
    expect(asked()).toEqual(['GET /gmail/v1/users/me/threads/t1'])
    expect(messages.map((message) => message.id)).toEqual(['m1', 'm2', 'm3'])
    expect(messages[2]).toMatchObject({
      threadId: 't1',
      from: 'Grace Hopper <grace@example.com>',
      to: 'Ada Lovelace <ada@gmail.com>',
      cc: 'Linus Example <linus@example.com>, ada@gmail.com',
      subject: 'Re: Episode 12 thumbnail',
      messageId: '<m3@mail.test>',
      inReplyTo: '<m2@mail.test>',
      references: '<m1@mail.test> <m2@mail.test>',
      text: 'Hi Ada,\n\nHere is the second version. The title is larger.\n\nGrace',
      hasHtml: true,
      attachments: [{ partId: '1', filename: 'thumbnail-v2.png', type: 'image/png', size: 26 }],
    })
    expect(messages[0]).toMatchObject({ hasHtml: false, attachments: [] })
    expect(await getThread(box, 'no-such-thread')).toBeNull()
  })

  it('hands over the HTML part, also when Gmail keeps a long one apart from the message', async () => {
    const { box } = await mailSite()
    expect(await getHtml(box, 'm3')).toContain('<b>second version</b>')
    expect(await getHtml(box, 'm9')).toMatch(/^<p>A long one\.<\/p>/)
    expect(await getHtml(box, 'm1')).toBeNull()
    expect(await getHtml(box, 'gone')).toBeNull()
  })

  it('finds an attachment by its place in the message, since Gmail’s id for it keeps changing', async () => {
    const { box } = await mailSite()
    const file = (await getAttachment(box, 'm3', '1'))!
    expect(file).toMatchObject({ filename: 'thumbnail-v2.png', type: 'image/png' })
    expect(file.content.toString()).toBe('PNG-BYTES-OF-THE-THUMBNAIL')
    expect((await getAttachment(box, 'm3', '1'))!.content.toString()).toBe(
      'PNG-BYTES-OF-THE-THUMBNAIL',
    )
    expect(await getAttachment(box, 'm3', '7')).toBeNull()
    expect(await getAttachment(box, 'm1', '1')).toBeNull()
  })

  it('offers only the addresses Gmail has verified to send from', async () => {
    const { box } = await mailSite()
    expect(await listSendAs(box)).toEqual([
      { email: 'ada@gmail.com', name: 'Ada Lovelace', primary: true },
      { email: 'support@example.com', name: 'Ada, Support', primary: false },
    ])
  })

  it('reads an encoded header, and leaves alone one it can’t', () => {
    expect(decodeHeader('=?UTF-8?B?w4lsw6lhbm9y?= <e@x.test>')).toBe('Éléanor <e@x.test>')
    expect(decodeHeader('=?ISO-8859-1?Q?Andr=E9_Dupont?=')).toBe('André Dupont')
    expect(decodeHeader('=?no-such-charset?B?QQ==?=')).toBe('=?no-such-charset?B?QQ==?=')
    expect(decodeHeader('Plain\r\n\tfolded')).toBe('Plain folded')
  })
})

describe('the frame a message’s HTML is shown in', () => {
  const frame = (site: GoogleSite, who: Person | null, query: Record<string, string>) =>
    site.get(`/api/p/google/gmail/html?${new URLSearchParams(query)}`, who?.cookie ?? '')

  it('is a document with no scripts and no origin, that loads nothing from the web', async () => {
    const { site, ada, account } = await mailSite()
    const response = await frame(site, ada, { account, message: 'm5' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('content-security-policy')).toBe(
      "sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
    )
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const html = await response.text()
    expect(html).toContain('Security alert')
    expect(html).not.toMatch(
      /<script|onclick|onerror|javascript:|evil\.test|<form|<iframe|<svg|<base|<meta http-equiv/i,
    )
  })

  it('lets pictures from the web in only when asked', async () => {
    const { site, ada, account } = await mailSite()
    expect(frameSecurity(false)).not.toContain('https:')
    const asked = await frame(site, ada, { account, message: 'm3', images: '1' })
    expect(asked.headers.get('content-security-policy')).toContain('img-src data: https:;')
    const anything = await frame(site, ada, { account, message: 'm3', images: 'yes' })
    expect(anything.headers.get('content-security-policy')).toContain('img-src data:;')
  })

  it('is the owner’s alone: anyone else gets nothing, and Gmail is never asked', async () => {
    const { site, ada, account, asked } = await mailSite()
    const eve = await site.person('eve@cms.test', 'editor')
    expect((await frame(site, eve, { account, message: 'm3' })).status).toBe(404)
    expect((await frame(site, null, { account, message: 'm3' })).status).toBe(401)
    const customer = await site.person('c@cms.test', 'customer')
    expect((await frame(site, customer, { account, message: 'm3' })).status).toBe(401)
    expect((await frame(site, ada, { account: 'not-an-id', message: 'm3' })).status).toBe(404)
    expect((await frame(site, ada, { account, message: '../labels' })).status).toBe(404)
    expect(asked()).toEqual([])
    // Even an error is said inside the same locked-down document.
    const missing = await frame(site, ada, { account, message: 'm1' })
    expect(missing.status).toBe(404)
    expect(missing.headers.get('content-security-policy')).toContain('sandbox')
    expect(await missing.text()).toContain('no formatted part')
  })
})

describe('an attachment', () => {
  const download = (site: GoogleSite, who: Person | null, query: Record<string, string>) =>
    site.get(`/api/p/google/gmail/attachment?${new URLSearchParams(query)}`, who?.cookie ?? '')

  it('comes as a download, never as the type its sender gave it', async () => {
    const { site, ada, account } = await mailSite()
    const response = await download(site, ada, { account, message: 'm4', part: '1' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="invoice 2026-118 _.pdf"; filename*=UTF-8''invoice%202026-118%20%C3%A9.pdf`,
    )
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('%PDF-1.7 invoice')
  })

  it('refuses one beyond Gmail’s own limit, by what Gmail says and by what it sends', async () => {
    const { site, ada, account, mail, box } = await mailSite()
    const invoice = mail().messages.find((message) => message.id === 'm4')!.attachments[0]!
    // Gmail says it's too large: it isn't fetched at all.
    invoice.claimedSize = MAX_ATTACHMENT_BYTES + 1
    const stated = await download(site, ada, { account, message: 'm4', part: '1' })
    expect(stated.status).toBe(413)
    expect(
      site.fake.requests.filter((request) => request.path.includes('/attachments/')),
    ).toHaveLength(0)
    // Gmail says it's small and sends far more: the reading stops, nothing that size is held.
    invoice.claimedSize = 10
    invoice.data = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1024 * 1024, 65)
    await expect(getAttachment(box, 'm4', '1')).rejects.toMatchObject({
      name: 'GoogleError',
      message: 'Google’s answer was larger than expected.',
    })
    expect((await download(site, ada, { account, message: 'm4', part: '1' })).status).toBe(502)
  })

  it('is the owner’s alone, and only by a part the message has', async () => {
    const { site, ada, account, asked } = await mailSite()
    const eve = await site.person('eve@cms.test', 'editor')
    expect((await download(site, eve, { account, message: 'm4', part: '1' })).status).toBe(404)
    expect((await download(site, null, { account, message: 'm4', part: '1' })).status).toBe(401)
    expect((await download(site, ada, { account, message: 'm4', part: '../1' })).status).toBe(404)
    expect((await download(site, ada, { account, message: 'm4/x', part: '1' })).status).toBe(404)
    expect(asked()).toEqual([])
    expect((await download(site, ada, { account, message: 'm4', part: '9' })).status).toBe(404)
  })
})

describe('changing conversations', () => {
  it('archives, trashes and restores, reports spam and takes it back', async () => {
    const { site, ada, account, labelsOf } = await mailSite()
    const one = (id: string): Fields => [
      ['account', account],
      ['id', id],
      ['label', 'Label_1'],
      ['q', ''],
    ]
    const archived = await post(site, ada, 'archive', one('t1'))
    expect(archived.flash).toEqual({ kind: 'notice', message: 'Conversation archived.' })
    // The open conversation left its list: back to that list.
    expect(archived.path).toBe(`/admin/google/gmail?account=${account}&label=Label_1`)
    expect(labelsOf('t1')).not.toContain('INBOX')

    await post(site, ada, 'trash', one('t2'))
    expect(labelsOf('t2')).toEqual(['Label_2', 'TRASH', 'UNREAD'])
    await post(site, ada, 'untrash', one('t2'))
    expect(labelsOf('t2')).toEqual(['INBOX', 'Label_2', 'UNREAD'])
    await post(site, ada, 'spam', one('t2'))
    expect(labelsOf('t2')).toEqual(['Label_2', 'SPAM', 'UNREAD'])
    await post(site, ada, 'not-spam', one('t2'))
    expect(labelsOf('t2')).toEqual(['INBOX', 'Label_2', 'UNREAD'])
    // Nothing here deletes for good.
    expect(site.fake.requests.filter((request) => request.method === 'DELETE')).toEqual([])
  })

  it('marks read and unread, stars, and changes the ticked ones together', async () => {
    const { site, ada, account, labelsOf } = await mailSite()
    const ticked: Fields = [
      ['account', account],
      ['ids', 't1'],
      ['ids', 't2'],
      ['ids', 't3'],
    ]
    const read = await post(site, ada, 'read', ticked)
    expect(read.flash).toEqual({ kind: 'notice', message: '3 conversations marked as read.' })
    // From the list: back to where the form was.
    expect(read.path).toBe('/admin/google/gmail')
    for (const id of ['t1', 't2', 't3']) expect(labelsOf(id)).not.toContain('UNREAD')
    await post(site, ada, 'unread', [
      ['account', account],
      ['ids', 't2'],
    ])
    expect(labelsOf('t2')).toContain('UNREAD')
    await post(site, ada, 'star', [
      ['account', account],
      ['id', 't2'],
    ])
    expect(labelsOf('t2')).toContain('STARRED')
    await post(site, ada, 'unstar', [
      ['account', account],
      ['id', 't2'],
    ])
    expect(labelsOf('t2')).not.toContain('STARRED')
  })

  it('applies and removes one of the person’s own labels, never one of Gmail’s by name', async () => {
    const { site, ada, account, labelsOf } = await mailSite()
    const apply = (label: string): Fields => [
      ['account', account],
      ['id', 't2'],
      ['apply', label],
    ]
    expect((await post(site, ada, 'label-add', apply('Label_1'))).flash!.message).toBe(
      'Label applied.',
    )
    expect(labelsOf('t2')).toContain('Label_1')
    await post(site, ada, 'label-remove', apply('Label_1'))
    expect(labelsOf('t2')).not.toContain('Label_1')
    for (const label of ['TRASH', 'SPAM', 'INBOX', 'Label_999', '', '../x']) {
      const refused = await post(site, ada, 'label-add', apply(label))
      expect({ label, flash: refused.flash }).toEqual({
        label,
        flash: { kind: 'error', message: 'Choose one of your labels.' },
      })
    }
    expect(labelsOf('t2')).toEqual(['INBOX', 'Label_2', 'UNREAD'])
  })

  it('refuses another person’s account, a signed-out post, nothing ticked and ids that aren’t ids', async () => {
    const { site, ada, account, asked, labelsOf } = await mailSite()
    const eve = await site.person('eve@cms.test', 'editor')
    const before = labelsOf('t1')
    const stolen = await post(site, eve, 'trash', [
      ['account', account],
      ['id', 't1'],
    ])
    expect(stolen.flash).toEqual({
      kind: 'error',
      message: 'That Google account isn’t connected, or hasn’t allowed Gmail.',
    })
    expect(
      (
        await post(site, null, 'trash', [
          ['account', account],
          ['id', 't1'],
        ])
      ).path,
    ).toMatch(/^\/admin\/login/)
    const customer = await site.person('c@cms.test', 'customer')
    expect(
      (
        await post(site, customer, 'trash', [
          ['account', account],
          ['id', 't1'],
        ])
      ).status,
    ).toBe(403)
    expect((await post(site, ada, 'trash', [['account', account]])).flash!.message).toBe(
      'Tick at least one conversation first.',
    )
    for (const id of ['../../labels/Label_1', 't1/modify', 't 1', 'x'.repeat(513)]) {
      const refused = await post(site, ada, 'trash', [
        ['account', account],
        ['ids', id],
      ])
      expect(refused.flash!.kind).toBe('error')
    }
    const many: Fields = [
      ['account', account],
      ...Array.from({ length: 51 }, (_, n): [string, string] => ['ids', `t${n}`]),
    ]
    expect((await post(site, ada, 'read', many)).flash!.kind).toBe('error')
    expect(asked()).toEqual([])
    expect(labelsOf('t1')).toEqual(before)
  })

  it('registers every change it knows as an action', () => {
    expect([...THREAD_ACTIONS].sort()).toEqual([...THREAD_CHANGES].sort())
  })
})

describe('labels', () => {
  it('are added, renamed and deleted; Google’s own words for a refusal never reach the page', async () => {
    const { site, ada, account, mail } = await mailSite()
    const added = await post(site, ada, 'label-create', [
      ['account', account],
      ['name', ' Receipts '],
    ])
    expect(added.flash).toEqual({ kind: 'notice', message: 'The label “Receipts” was added.' })
    const receipts = mail().labels.find((label) => label.name === 'Receipts')!
    const twice = await post(site, ada, 'label-create', [
      ['account', account],
      ['name', 'receipts'],
    ])
    expect(twice.flash).toEqual({
      kind: 'error',
      message: 'Google refused to add that label; one with that name may exist already.',
    })
    await post(site, ada, 'label-rename', [
      ['account', account],
      ['id', receipts.id],
      ['name', 'Paid'],
    ])
    expect(mail().labels.find((label) => label.id === receipts.id)!.name).toBe('Paid')
    await post(site, ada, 'label-delete', [
      ['account', account],
      ['id', receipts.id],
    ])
    expect(mail().labels.map((label) => label.name)).toEqual(['Clients', 'Invoices'])
  })

  it('need a name, and are the person’s own: Gmail’s labels can’t be renamed or deleted here', async () => {
    const { site, ada, account, mail } = await mailSite()
    for (const name of ['', '   ', 'x'.repeat(101), 'two\nlines']) {
      const refused = await post(site, ada, 'label-create', [
        ['account', account],
        ['name', name],
      ])
      expect(refused.flash!.message).toBe('Give the label a name of up to 100 characters.')
    }
    for (const id of ['INBOX', 'TRASH', 'Label_404', '']) {
      expect(
        (
          await post(site, ada, 'label-rename', [
            ['account', account],
            ['id', id],
            ['name', 'X'],
          ])
        ).flash!.message,
      ).toBe('Choose one of your labels.')
      expect(
        (
          await post(site, ada, 'label-delete', [
            ['account', account],
            ['id', id],
          ])
        ).flash!.message,
      ).toBe('Choose one of your labels.')
    }
    expect(mail().labels).toHaveLength(2)
  })
})

describe('writing', () => {
  const letter = (account: string, extra: Fields = []): Fields => [
    ['account', account],
    ['from', 'ada@gmail.com'],
    ['to', 'Grace Hopper <grace@example.com>, linus@example.com'],
    ['cc', ''],
    ['bcc', 'archive@example.com'],
    ['subject', 'Épisode 12'],
    ['body', 'Hi Grace,\n\nThat one works.\n\nAda'],
    ...extra,
  ]

  it('sends a new message as the account, with what was typed and nothing else', async () => {
    const { site, ada, account } = await mailSite()
    const done = await post(site, ada, 'send', letter(account), true)
    expect(done.flash).toEqual({ kind: 'notice', message: 'Your message was sent.' })
    expect(done.path).toBe(`/admin/google/gmail?account=${account}`)
    expect(site.fake.sent).toHaveLength(1)
    const { mime, threadId, who } = site.fake.sent[0]!
    expect(who).toBe('ada')
    expect(threadId).toBeNull()
    expect(header(mime, 'From')).toBe('"Ada Lovelace" <ada@gmail.com>')
    expect(header(mime, 'To')).toBe('"Grace Hopper" <grace@example.com>, linus@example.com')
    expect(header(mime, 'Bcc')).toBe('archive@example.com')
    expect(header(mime, 'Cc')).toBeNull()
    expect(header(mime, 'Subject')).toBe('=?UTF-8?B?w4lwaXNvZGUgMTI=?=')
    expect(header(mime, 'In-Reply-To')).toBeNull()
    expect(sentText(mime)).toBe('Hi Grace,\n\nThat one works.\n\nAda')
  })

  it('sends from an alias Gmail has verified, and from no other address', async () => {
    const { site, ada, account } = await mailSite()
    const from = (address: string) =>
      letter(account).map(([key, value]): [string, string | File] =>
        key === 'from' ? [key, address] : [key, value],
      )
    await post(site, ada, 'send', from('support@example.com'), true)
    expect(header(site.fake.sent[0]!.mime, 'From')).toBe('"Ada, Support" <support@example.com>')
    for (const address of ['pending@example.com', 'ceo@example.com', '', 'Ada <ada@gmail.com>']) {
      const refused = await post(site, ada, 'send', from(address), true)
      expect({ address, flash: refused.flash }).toEqual({
        address,
        flash: { kind: 'error', message: 'Choose one of the addresses this account sends from.' },
      })
    }
    expect(site.fake.sent).toHaveLength(1)
  })

  it('refuses what isn’t an address or would add a header, rather than send something else', async () => {
    const { site, ada, account } = await mailSite()
    const change = (name: string, value: string) =>
      letter(account).map(([key, old]): [string, string | File] =>
        key === name ? [key, value] : [key, old],
      )
    const cases: [string, string, string][] = [
      ['to', 'grace@example.com\r\nBcc: spy@evil.test', 'To can’t contain a line break.'],
      ['subject', 'Hello\nBcc: spy@evil.test', 'The subject can’t contain a line break.'],
      ['cc', 'x\ry@example.com', 'Cc can’t contain a line break.'],
      ['to', 'not an address', 'To: “not an address” isn’t an email address.'],
      [
        'to',
        'Grace <grace@example.com> <spy@evil.test>',
        'To: “Grace <grace@example.com> <spy@evil.test>” isn’t an email address.',
      ],
      ['bcc', 'a@b', 'Bcc: “a@b” isn’t an email address.'],
      ['subject', 'x'.repeat(501), 'The subject can have 500 characters at most.'],
    ]
    for (const [name, value, message] of cases) {
      const refused = await post(site, ada, 'send', change(name, value), true)
      expect({ name, flash: refused.flash }).toEqual({ name, flash: { kind: 'error', message } })
    }
    const nobody = letter(account).map(([key, value]): [string, string | File] =>
      ['to', 'bcc'].includes(key) ? [key, ''] : [key, value],
    )
    expect((await post(site, ada, 'send', nobody, true)).flash!.message).toBe(
      'Say who the message is to.',
    )
    const eve = await site.person('eve@cms.test', 'editor')
    expect((await post(site, eve, 'send', letter(account), true)).flash!.message).toBe(
      'That Google account isn’t connected, or hasn’t allowed Gmail.',
    )
    expect(site.fake.sent).toEqual([])
    expect(recipients('"Hopper, Grace" <grace@example.com>; ada@gmail.com', 'To')).toEqual([
      'Hopper, Grace <grace@example.com>',
      'ada@gmail.com',
    ])
  })

  it('answers in the conversation, by what Gmail says the message is: the form can’t say otherwise', async () => {
    const { site, ada, account } = await mailSite()
    const reply = letter(account, [
      ['reply', 'm3'],
      // What a forged form might add: none of it is read.
      ['threadId', 't2'],
      ['inReplyTo', '<forged@evil.test>'],
      ['references', '<forged@evil.test>'],
    ])
    await post(site, ada, 'send', reply, true)
    const { mime, threadId } = site.fake.sent[0]!
    expect(threadId).toBe('t1')
    expect(header(mime, 'In-Reply-To')).toBe('<m3@mail.test>')
    expect(header(mime, 'References')).toBe('<m1@mail.test> <m2@mail.test> <m3@mail.test>')
    const gone = await post(
      site,
      ada,
      'send',
      letter(account, [['reply', 'no-such-message']]),
      true,
    )
    expect(gone.flash!.message).toBe('The message you’re answering is no longer there.')
    expect(site.fake.sent).toHaveLength(1)
  })

  it('keeps a draft, changes it, and deletes it once it’s sent', async () => {
    const { site, ada, account, box, mail } = await mailSite()
    const saved = await post(site, ada, 'draft-save', letter(account, [['reply', 'm3']]), true)
    expect(saved.flash).toEqual({ kind: 'notice', message: 'Draft saved.' })
    const draftId = new URL(saved.path, ORIGIN).searchParams.get('draft')!
    expect(saved.path).toBe(`/admin/google/gmail/compose?account=${account}&draft=${draftId}`)
    expect(mail().drafts.map((draft) => draft.id)).toEqual([draftId, 'd1'])
    expect(await getDraft(box, draftId)).toMatchObject({
      threadId: 't1',
      subject: 'Épisode 12',
      inReplyTo: '<m3@mail.test>',
      text: 'Hi Grace,\r\n\r\nThat one works.\r\n\r\nAda',
    })
    // A draft needs nobody to go to yet.
    const empty = letter(account).map(([key, value]): [string, string | File] =>
      ['to', 'bcc'].includes(key) ? [key, ''] : [key, value],
    )
    expect((await post(site, ada, 'draft-save', empty, true)).flash!.kind).toBe('notice')

    // Edited: the same draft, new words, still an answer in its conversation.
    const edited = letter(account, [['draft', draftId]]).map(
      ([key, value]): [string, string | File] =>
        key === 'body' ? [key, 'Second thoughts.'] : [key, value],
    )
    await post(site, ada, 'draft-save', edited, true)
    expect(mail().drafts).toHaveLength(3)
    expect(await getDraft(box, draftId)).toMatchObject({
      text: 'Second thoughts.',
      threadId: 't1',
      inReplyTo: '<m3@mail.test>',
    })

    const sent = await post(site, ada, 'send', edited, true)
    expect(sent.flash!.message).toBe('Your message was sent.')
    expect(site.fake.sent.at(-1)).toMatchObject({ threadId: 't1' })
    expect(header(site.fake.sent.at(-1)!.mime, 'In-Reply-To')).toBe('<m3@mail.test>')
    expect(mail().drafts.map((draft) => draft.id)).not.toContain(draftId)

    const discarded = await post(site, ada, 'draft-delete', [
      ['account', account],
      ['draft', 'd1'],
    ])
    expect(discarded.path).toBe(`/admin/google/gmail?account=${account}&label=DRAFT`)
    expect(mail().drafts.map((draft) => draft.id)).not.toContain('d1')
  })

  it('attaches the files chosen, and ones carried from a forwarded message or a draft', async () => {
    const { site, ada, account } = await mailSite()
    const file = new File([Buffer.from('brief bytes')], 'brief é.pdf', { type: 'application/pdf' })
    await post(
      site,
      ada,
      'send',
      letter(account, [
        ['files', file],
        ['source', 'm3'],
        ['keep', '1'],
      ]),
      true,
    )
    const { mime } = site.fake.sent[0]!
    expect(mime).toContain('Content-Type: multipart/mixed')
    expect(mime).toContain(`Content-Disposition: attachment; filename="thumbnail-v2.png"`)
    expect(mime).toContain(Buffer.from('PNG-BYTES-OF-THE-THUMBNAIL').toString('base64'))
    expect(mime).toContain(`filename="brief _.pdf"; filename*=UTF-8''brief%20%C3%A9.pdf`)
    expect(mime).toContain(Buffer.from('brief bytes').toString('base64'))

    // Only by a place in a real message: anything else is refused before Gmail is asked for it.
    const shapeless: Fields[] = [
      [
        ['source', '../m3'],
        ['keep', '1'],
      ],
      [
        ['source', 'm3'],
        ['keep', '../1'],
      ],
      [['keep', '1']],
    ]
    for (const fields of shapeless) {
      const refused = await post(site, ada, 'send', letter(account, fields), true)
      expect({ fields, flash: refused.flash }).toEqual({
        fields,
        flash: {
          kind: 'error',
          message: 'Those attachments can’t be carried over. Attach them again.',
        },
      })
    }
    const missing = await post(
      site,
      ada,
      'send',
      letter(account, [
        ['source', 'm3'],
        ['keep', '9'],
      ]),
      true,
    )
    expect(missing.flash!.message).toBe('An attachment to carry over is no longer there.')
    expect(site.fake.sent).toHaveLength(1)
  })

  it('refuses attachments beyond ten files or ten megabytes, and sends nothing', async () => {
    const { site, ada, account } = await mailSite()
    const big = new File([Buffer.alloc(MAX_ATTACHED_BYTES + 1, 65)], 'big.bin')
    const heavy = await post(site, ada, 'send', letter(account, [['files', big]]), true)
    expect(heavy.flash!.message).toBe(
      'Attachments can come to 10 MB at most. Send larger files as a link.',
    )
    const eleven: Fields = Array.from({ length: 11 }, (_, n): [string, File] => [
      'files',
      new File(['x'], `f${n}.txt`),
    ])
    expect((await post(site, ada, 'send', letter(account, eleven), true)).flash!.message).toBe(
      'Attach up to 10 files at a time.',
    )
    // New files and carried ones are counted together.
    const nearly = new File([Buffer.alloc(MAX_ATTACHED_BYTES - 10, 65)], 'nearly.bin')
    const together = await post(
      site,
      ada,
      'send',
      letter(account, [
        ['files', nearly],
        ['source', 'm3'],
        ['keep', '1'],
      ]),
      true,
    )
    expect(together.flash!.message).toBe(
      'Attachments can come to 10 MB at most. Send larger files as a link.',
    )
    expect(site.fake.sent).toEqual([])
  })

  it('sends a large message through Gmail’s upload address, still in its conversation', async () => {
    const { site, ada, account, asked } = await mailSite()
    const large = new File([Buffer.alloc(4 * 1024 * 1024, 66)], 'large.bin')
    asked()
    const done = await post(
      site,
      ada,
      'send',
      letter(account, [
        ['files', large],
        ['reply', 'm3'],
      ]),
      true,
    )
    expect(done.flash!.message).toBe('Your message was sent.')
    expect(asked()).toContain('POST /upload/gmail/v1/users/me/messages/send')
    expect(site.fake.sent[0]).toMatchObject({ threadId: 't1', upload: true })
    expect(header(site.fake.sent[0]!.mime, 'In-Reply-To')).toBe('<m3@mail.test>')
  })
})

describe('switched off', () => {
  it('has no screens and no actions, and its addresses hand over nothing', async () => {
    const site = await bootGoogle({ routes: [fakeGmail], settings: { 'google.gmail': false } })
    const ada = await site.person('ada@gmail.com')
    // Gmail's permission can't even be asked for.
    expect((await site.leave(ada, { service: 'gmail' })).response.status).toBe(404)
    expect((await site.connect(ada, 'ada')).outcome).toBe('connected')
    const account = (await listAccounts(site.cms(), ada.user.id))[0]!.id
    expect((await site.screen('/admin/google/gmail', ada.user)).kind).toBe('not-found')
    expect((await site.screen('/admin/google/gmail/compose', ada.user)).kind).toBe('not-found')
    expect(
      (
        await post(site, ada, 'trash', [
          ['account', account],
          ['id', 't1'],
        ])
      ).status,
    ).toBe(404)
    const html = await site.get(
      `/api/p/google/gmail/html?account=${account}&message=m3`,
      ada.cookie,
    )
    expect(html.status).toBe(404)
    const file = await site.get(
      `/api/p/google/gmail/attachment?account=${account}&message=m4&part=1`,
      ada.cookie,
    )
    expect(file.status).toBe(404)
    expect(site.fake.requests.filter((request) => request.host === 'gmail.googleapis.com')).toEqual(
      [],
    )
  })
})
