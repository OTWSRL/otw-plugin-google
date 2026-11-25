import { definePlugin, type OutgoingMail } from '@otwdesign/sdk'
import { describe, expect, it } from 'vitest'
import { listAccounts } from '../src/accounts'
import { bootGoogle, SEND, type GoogleSite, type Person } from './fixtures'

const MAIL_ON = { 'google.site_mail': true } as const

/** A site whose email goes out through Ada's Gmail, chosen with the screen's own buttons. */
async function mailSite() {
  const site = await bootGoogle({ settings: MAIL_ON })
  const ada = await site.person('ada@gmail.com')
  await site.connect(ada, 'ada')
  const [account] = await listAccounts(site.cms(), ada.user.id)
  return { site, ada, account: account! }
}

/** Presses "Use for the site's email", going to Google for the permission when it's missing. */
async function useForSiteMail(site: GoogleSite, who: Person, accountId: string, google: string) {
  const first = await site.act(who.cookie, 'site-mail', { id: accountId })
  if (!first.location?.startsWith('/api/p/google/oauth/start')) return first
  const start = new URL(first.location, 'http://cms.test')
  const left = await site.leave(who, Object.fromEntries(start.searchParams))
  await site.back(who, left.cookie, site.fake.authorize(left.location, google))
  return site.act(who.cookie, 'site-mail', { id: accountId })
}

const sentHeaders = (site: GoogleSite, index = 0) => {
  const mime = site.fake.sent[index]!.mime
  return mime.slice(0, mime.indexOf('\r\n\r\n'))
}

describe('the site’s email through Gmail', () => {
  it('asks Google only for sending, then goes out from the chosen account', async () => {
    const { site, ada, account } = await mailSite()
    expect(site.kernel.mail.canSend()).toBe(true)
    // Not chosen yet: the message fails, and the log says why without stopping the caller.
    expect(await site.kernel.mail.send({ to: 'x@example.com', subject: 'S', text: 'T' })).toBe(
      false,
    )

    const first = await site.act(ada.cookie, 'site-mail', { id: account.id })
    expect(first.location).toBe(`/api/p/google/oauth/start?service=mail&account=${account.id}`)
    const left = await site.leave(ada, { service: 'mail', account: account.id })
    expect(new URL(left.location).searchParams.get('scope')).toBe(`openid email profile ${SEND}`)

    const chosen = await useForSiteMail(site, ada, account.id, 'ada')
    expect(chosen.flash).toEqual({
      kind: 'notice',
      message: 'The site’s email now goes out from ada@gmail.com.',
    })

    const sent = await site.kernel.mail.send({
      to: ['grace@example.com', 'Linus <linus@elsewhere.test>'],
      subject: 'Your order 1001',
      text: 'Thanks for your order.',
      html: '<p>Thanks for your order.</p>',
      from: 'Shop <orders@shop.test>',
      replyTo: 'help@shop.test',
    })
    expect(sent).toBe(true)
    expect(site.fake.sent).toHaveLength(1)
    expect(site.fake.sent[0]!.from).toBe('ada@gmail.com')
    const headers = sentHeaders(site)
    // Gmail sends as the account itself: the site's name stays, the address is the account's.
    expect(headers).toContain('From: "Shop" <ada@gmail.com>')
    expect(headers).toContain('To: grace@example.com, "Linus" <linus@elsewhere.test>')
    expect(headers).toContain('Reply-To: help@shop.test')
    expect(headers).toContain('Subject: Your order 1001')
    expect(site.fake.sent[0]!.mime).toContain('Content-Type: text/html; charset=UTF-8')
  })

  it('sends a test email from the accounts screen, and says when it can’t', async () => {
    const { site, ada, account } = await mailSite()
    const early = await site.act(ada.cookie, 'test-mail', { to: 'ada@gmail.com' })
    expect(early.flash).toEqual({
      kind: 'error',
      message: 'Choose the account the site’s email goes out from first.',
    })
    await useForSiteMail(site, ada, account.id, 'ada')
    expect((await site.act(ada.cookie, 'test-mail', { to: 'not an address' })).flash!.kind).toBe(
      'error',
    )
    const done = await site.act(ada.cookie, 'test-mail', { to: 'ada@gmail.com' })
    expect(done.flash).toEqual({
      kind: 'notice',
      message: 'A test email is on its way to ada@gmail.com.',
    })
    expect(sentHeaders(site)).toContain('Subject: A test email from Shop')

    site.fake.revoke('ada')
    const failed = await site.act(ada.cookie, 'test-mail', { to: 'ada@gmail.com' })
    expect(failed.flash).toEqual({
      kind: 'error',
      message: 'The test email couldn’t be sent. The server log says why.',
    })
  })

  it('goes out from another person’s account only when they allowed it, and a message names it', async () => {
    const { site, ada, account } = await mailSite()
    await useForSiteMail(site, ada, account.id, 'ada')
    const grace = await site.person('grace@example.com', 'editor')
    await site.connect(grace, 'grace', { service: 'mail' })
    const [hers] = await listAccounts(site.cms(), grace.user.id)

    const message: OutgoingMail = {
      from: 'Grace <grace@example.com>',
      to: ['x@example.com'],
      subject: 'S',
      text: 'T',
      html: null,
      replyTo: null,
    }
    await site.kernel.mail.send(message)
    // Not allowed by its owner: it goes from the site's account.
    expect(site.fake.sent.at(-1)!.from).toBe('ada@gmail.com')
    expect(sentHeaders(site, site.fake.sent.length - 1)).toContain('From: "Grace" <ada@gmail.com>')

    const allowed = await site.act(grace.cookie, 'sends-mail', { id: hers!.id, allowed: '1' })
    expect(allowed.flash!.message).toBe('This site may now send email from grace@example.com.')
    await site.kernel.mail.send(message)
    expect(site.fake.sent.at(-1)!.from).toBe('grace@example.com')
    // Nobody but its owner switches that: Ada's post for Grace's account changes nothing.
    await site.act(ada.cookie, 'sends-mail', { id: hers!.id, allowed: '0' })
    await site.kernel.mail.send(message)
    expect(site.fake.sent.at(-1)!.from).toBe('grace@example.com')
    await site.act(grace.cookie, 'sends-mail', { id: hers!.id, allowed: '0' })
    await site.kernel.mail.send(message)
    expect(site.fake.sent.at(-1)!.from).toBe('ada@gmail.com')
  })

  it('is the administrator’s own account to choose, and theirs alone', async () => {
    const { site, ada, account } = await mailSite()
    const eve = await site.person('eve@cms.test', 'editor')
    // Not a manager: the action isn't theirs.
    expect((await site.act(eve.cookie, 'site-mail', { id: account.id })).status).toBe(403)
    // A manager can't point the site's email at someone else's account.
    const boss = await site.person('boss@cms.test')
    const refused = await site.act(boss.cookie, 'site-mail', { id: account.id })
    expect(refused.flash).toEqual({
      kind: 'error',
      message: 'That Google account isn’t connected any more.',
    })
    await useForSiteMail(site, ada, account.id, 'ada')
    // The site's sender can't quietly stop allowing it.
    expect(
      (await site.act(ada.cookie, 'sends-mail', { id: account.id, allowed: '0' })).flash!.kind,
    ).toBe('error')
    const off = await site.act(boss.cookie, 'site-mail-off')
    expect(off.flash!.kind).toBe('notice')
    expect(await site.kernel.mail.send({ to: 'x@example.com', subject: 'S', text: 'T' })).toBe(
      false,
    )
  })

  it('stays out of the way while the setting is off, or while Mailer is active', async () => {
    const off = await bootGoogle()
    expect(off.kernel.mail.canSend()).toBe(false)

    const inbox: OutgoingMail[] = []
    const mailer = definePlugin({
      id: 'mailer',
      version: '1.0.0',
      setup: (cms) => cms.mail.transport({ send: async (message) => void inbox.push(message) }),
    })
    const both = await bootGoogle({ settings: MAIL_ON, plugins: [mailer] })
    expect(await both.kernel.mail.send({ to: 'x@example.com', subject: 'S', text: 'T' })).toBe(true)
    expect(inbox).toHaveLength(1)
    expect(both.fake.sent).toEqual([])
  })
})
