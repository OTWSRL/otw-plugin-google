import { describe, expect, it } from 'vitest'
import { listAccounts } from '../src/accounts'
import { fakeDrive, type FakeDrive } from './fake-drive.mjs'
import { bootGoogle, type BootOptions } from './fixtures'

const PAGE = '/admin/google/drive'

async function driveSite(options: BootOptions = {}) {
  const site = await bootGoogle({ routes: [fakeDrive], ...options })
  const ada = await site.person('ada@gmail.com')
  await site.connect(ada, 'ada', { service: 'drive' })
  const [account] = await listAccounts(site.cms(), ada.user.id)
  const drive = () => (site.fake.data.drive as Record<string, FakeDrive>).ada!
  return { site, ada, account: account!.id, drive }
}

/** The part of the page that is one file's row, by its name. */
const rowOf = (html: string, name: string) =>
  html.split('<tr').find((row) => row.includes(`>${name}<`)) ?? ''

describe('the Drive screen', () => {
  it('shows the top folder with links into it, and sends no script', async () => {
    const { site, ada, account } = await driveSite()
    const page = await site.screen(PAGE, ada.user)
    expect(page).toMatchObject({ kind: 'page', title: 'Drive' })
    const { html } = page
    expect(html).toContain('<b>My Drive</b>')
    expect(html).toContain(`href="${PAGE}?account=${account}&amp;folder=clients"`)
    expect(html).toContain('huge.bin')
    expect(html).toContain('9.8 GB of 15 GB used in this Google account.')
    expect(html).toContain('4 items')
    // The account chooser, the search and the trash view.
    expect(html).toContain(`<option value="${account}" selected="">ada@gmail.com</option>`)
    expect(html).toContain('name="q"')
    expect(html).toContain(`href="${PAGE}?account=${account}&amp;view=trash"`)
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/ on[a-z]+="/)
  })

  it('offers each kind of file what can be done with it', async () => {
    const { site, ada, account } = await driveSite()
    const { html } = await site.screen(PAGE, ada.user, { folder: 'acme' })
    // Where it is.
    expect(html).toContain(`<a href="${PAGE}?account=${account}">My Drive</a>`)
    expect(html).toContain(`<a href="${PAGE}?account=${account}&amp;folder=clients">Clients</a>`)
    expect(html).toContain('<b>Acme</b>')

    const video = rowOf(html, 'Episode 12, final cut.mp4')
    expect(video).toContain(`href="/api/p/google/drive/files/episode12/preview?account=${account}"`)
    expect(video).toContain(
      `href="/api/p/google/drive/files/episode12/download?account=${account}"`,
    )
    expect(video).toContain(
      `href="/admin/google/youtube/upload?account=${account}&amp;drive=episode12"`,
    )
    expect(video).toContain('action="/api/p/google/actions/drive-to-media"')
    expect(video).toContain('action="/api/p/google/actions/drive-trash"')
    expect(video).toContain('action="/api/p/google/actions/drive-rename"')
    expect(video).toContain('2 KB')

    // HTML can be saved, never shown from this site's address.
    const page = rowOf(html, 'page.html')
    expect(page).toContain('/drive/files/page/download')
    expect(page).not.toContain('/drive/files/page/preview')
    expect(rowOf(html, 'logo.svg')).not.toContain('/preview')
    expect(page).not.toContain('Send to YouTube')

    // One of Google's documents opens at Google, in a tab that can't reach this one.
    const plan = rowOf(html, 'Launch plan')
    expect(plan).toContain(
      '<a href="https://docs.google.com/document/d/plan/edit" target="_blank" rel="noopener noreferrer">Open in Google</a>',
    )
    expect(plan).not.toContain('/download')
    expect(plan).not.toContain('drive-to-media')
    // A link that isn't Google's never reaches the page.
    expect(rowOf(html, 'Hours, November')).not.toContain('Open in Google')
    expect(html).not.toContain('javascript:')

    const folder = rowOf(html, 'Raw footage')
    expect(folder).toContain(`href="${PAGE}?account=${account}&amp;folder=raw"`)
    expect(folder).not.toContain('/download')
    expect(rowOf(html, 'From Grace.txt')).toContain('Grace Hopper')
  })

  it('writes a file’s name as text, whatever it holds', async () => {
    const { site, ada, drive } = await driveSite()
    drive().files.notes!.name = '<img src=x onerror=alert(1)>"\'.txt'
    const { html } = await site.screen(PAGE, ada.user, { folder: 'acme' })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('leaves out what the person or the site can’t do', async () => {
    const { site } = await driveSite({ settings: { 'google.youtube': false } })
    const guest = await site.person('guest@cms.test', 'google_user')
    await site.connect(guest, 'grace', { service: 'drive' })
    const fake = (site.fake.data.drive as Record<string, FakeDrive>).grace!
    fake.files.clip = {
      ...fake.files['grace-private']!,
      id: 'clip',
      name: 'clip.mp4',
      mimeType: 'video/mp4',
    }
    const { html } = await site.screen(PAGE, guest.user)
    const clip = rowOf(html, 'clip.mp4')
    expect(clip).toContain('/drive/files/clip/download')
    // YouTube is switched off, and a Google user may not add to the Media library.
    expect(clip).not.toContain('Send to YouTube')
    expect(clip).not.toContain('drive-to-media')
  })

  it('pages with Google’s token, and searches by name', async () => {
    const { site, ada, account } = await driveSite()
    const first = await site.screen(PAGE, ada.user, { folder: 'many' })
    expect(first.html).toContain('50 items')
    expect(first.html).toContain(
      `<a class="button" href="${PAGE}?account=${account}&amp;folder=many&amp;page=page%3A50">Next page</a>`,
    )
    expect(first.html).not.toContain('First page')
    const second = await site.screen(PAGE, ada.user, { folder: 'many', page: 'page:50' })
    expect(second.html).toContain('file 60.txt')
    expect(second.html).toContain(
      `<a class="button" href="${PAGE}?account=${account}&amp;folder=many">First page</a>`,
    )
    expect(second.html).not.toContain('Next page')

    const found = await site.screen(PAGE, ada.user, { q: "it's" })
    expect(found.html).toContain('Files whose name contains <b>it&#x27;s</b>.')
    expect(found.html).toContain('it&#x27;s a file.txt')
    expect(found.html).not.toContain('huge.bin')
    expect(found.html).not.toContain('New folder')
    const none = await site.screen(PAGE, ada.user, { q: 'nothing like this' })
    expect(none.html).toContain('No file’s name contains that.')
  })

  it('shows the trash, with a way back out of it', async () => {
    const { site, ada } = await driveSite()
    const { html } = await site.screen(PAGE, ada.user, { view: 'trash' })
    expect(html).toContain('old.txt')
    expect(html).not.toContain('huge.bin')
    expect(rowOf(html, 'old.txt')).toContain('action="/api/p/google/actions/drive-restore"')
    expect(rowOf(html, 'old.txt')).not.toContain('drive-trash')
    expect(html).toContain('Restore the ticked')
    expect(html).not.toContain('New folder')
  })

  it('falls back to the top folder for a folder id that can’t be one', async () => {
    const { site, ada } = await driveSite()
    const { html } = await site.screen(PAGE, ada.user, { folder: "x' or 'y" })
    expect(html).toContain('<b>My Drive</b>')
    expect(html).toContain('huge.bin')
  })

  it('asks for an account, or for Drive’s permission, before anything else', async () => {
    const site = await bootGoogle({ routes: [fakeDrive] })
    const ada = await site.person('ada@gmail.com')
    const none = await site.screen(PAGE, ada.user)
    expect(none.html).toContain('Connect a Google account to use Drive here.')
    expect(none.html).toContain(
      'href="/api/p/google/oauth/start?service=drive&amp;next=%2Fadmin%2Fgoogle%2Fdrive"',
    )

    await site.connect(ada, 'ada')
    const [account] = await listAccounts(site.cms(), ada.user.id)
    const notYet = await site.screen(PAGE, ada.user)
    expect(notYet.html).toContain('None of your Google accounts has allowed Drive yet.')
    expect(notYet.html).toContain(`account=${account!.id}`)
    expect(notYet.html).toContain('Allow Drive for ada@gmail.com')
    // Nothing was asked of Google's Drive for either.
    expect(site.fake.requests.filter((request) => request.path.startsWith('/drive/'))).toEqual([])
  })

  it('shows only the person’s own accounts, and which of them may use Drive', async () => {
    const { site, ada, account } = await driveSite()
    await site.connect(ada, 'linus')
    const eve = await site.person('eve@cms.test', 'editor')
    await site.connect(eve, 'grace', { service: 'drive' })
    const [eves] = await listAccounts(site.cms(), eve.user.id)
    const { html } = await site.screen(PAGE, ada.user, { account: eves!.id })
    // Someone else's account in the address shows the person's own instead.
    expect(html).toContain(`<option value="${account}" selected="">ada@gmail.com</option>`)
    expect(html).toContain('disabled="">linus@elsewhere.test (Drive not allowed yet)</option>')
    expect(html).not.toContain('grace@example.com')
    expect(html).not.toContain('Grace only.txt')
  })

  it('says what Google said went wrong, in this site’s words, and how to mend it', async () => {
    const { site, ada, account } = await driveSite()
    site.fake.failNext('/drive/v3/files', 400)
    const refused = await site.screen(PAGE, ada.user)
    expect(refused.html).toContain('Google refused that.')
    expect(refused.html).not.toContain('backendError')

    site.fake.revoke('ada')
    site.fake.expireAccessTokens()
    const ended = await site.screen(PAGE, ada.user)
    expect(ended.html).toContain('Google ended this connection. Connect the account again.')
    expect(ended.html).toContain(
      `href="/api/p/google/oauth/start?service=drive&amp;account=${account}&amp;next=%2Fadmin%2Fgoogle%2Fdrive"`,
    )
    expect(ended.html).not.toContain('huge.bin')
  })

  it('still lists the files when only the storage line can’t be read', async () => {
    const { site, ada } = await driveSite()
    site.fake.failNext('/drive/v3/about', 503, { times: 3 })
    const { html } = await site.screen(PAGE, ada.user)
    expect(html).toContain('huge.bin')
    expect(html).not.toContain('used in this Google account')
  })
})
