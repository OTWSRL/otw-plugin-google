import { describe, expect, it } from 'vitest'
import { listAccounts } from '../src/accounts'
import { clock } from '../src/services/youtube/screens'
import { formFields, readChanges } from '../src/services/youtube/forms'
import { bootGoogle, type BootOptions, type GoogleSite, type Person } from './fixtures'
import { fakeYouTube, type FakeYouTubeData } from './fake-youtube.mjs'

const tube = (site: GoogleSite) => site.fake.data.youtube as FakeYouTubeData

/** A site where `google` (one of the stand-in's people) has allowed YouTube for a new editor. */
async function channel(google = 'ada', options: BootOptions = {}) {
  const site = await bootGoogle({ routes: [fakeYouTube], ...options })
  const owner = await site.person(`${google}@cms.test`, 'editor')
  await site.connect(owner, google, { service: 'youtube' })
  const [account] = await listAccounts(site.cms(), owner.user.id)
  return { site, owner, account: account!.id }
}

const VALID = {
  title: 'Episode 12: the final cut',
  description: 'What changed since episode 11.',
  tags: 'cms, nextjs, cms',
  category: '28',
  privacy: 'private',
  kids: 'no',
}

const form = (fields: Record<string, string>) => {
  const data = new FormData()
  for (const [name, value] of Object.entries(fields)) data.set(name, value)
  return formFields(data)
}

describe('a video’s form', () => {
  it('reads the details, with tags once each', () => {
    expect(readChanges(form(VALID))).toEqual({
      title: 'Episode 12: the final cut',
      description: 'What changed since episode 11.',
      tags: ['cms', 'nextjs'],
      categoryId: '28',
      privacy: 'private',
      publishAt: null,
      madeForKids: false,
    })
  })

  it('says what to fix', () => {
    const refused = (changes: Record<string, string>, message: RegExp) =>
      expect(() => readChanges(form({ ...VALID, ...changes }), Date.UTC(2026, 10, 26))).toThrow(
        message,
      )
    refused({ title: '' }, /Give the video a title/)
    refused({ title: 'x'.repeat(101) }, /Give the video a title/)
    refused({ title: 'a <b> c' }, /without < or >/)
    refused({ description: 'x'.repeat(5001) }, /A description has up to 5000/)
    refused({ tags: 'x'.repeat(501) }, /Tags have up to 500/)
    refused({ category: 'movies' }, /Choose a category/)
    refused({ privacy: 'secret' }, /Choose who can see/)
    refused({ publish_at: '2026-11-01T09:00' }, /must be in the future/)
    refused({ publish_at: 'tomorrow' }, /must be in the future/)
    refused({ publish_at: '2026-12-01T09:00', privacy: 'public' }, /Only a private video/)
  })

  it('takes a time in UTC for a private video to go public', () => {
    const changes = readChanges(
      form({ ...VALID, publish_at: '2026-12-01T09:00', kids: 'yes' }),
      Date.UTC(2026, 10, 26),
    )
    expect(changes).toMatchObject({ publishAt: '2026-12-01T09:00:00.000Z', madeForKids: true })
  })

  it('writes a duration as a clock does', () => {
    expect(clock('PT18M42S')).toBe('18:42')
    expect(clock('PT1H2M3S')).toBe('1:02:03')
    expect(clock('PT45S')).toBe('0:45')
    expect(clock('P1D')).toBeNull()
    expect(clock(null)).toBeNull()
  })
})

describe('the YouTube screen', () => {
  it('asks someone with no account to connect one, and one without the permission to allow it', async () => {
    const site = await bootGoogle({ routes: [fakeYouTube] })
    const eve = await site.person('eve@cms.test', 'editor')
    const none = await site.screen('/admin/google/youtube', eve.user)
    expect(none.html).toContain('Connect a Google account to use YouTube here.')
    expect(none.html).toContain(
      'href="/api/p/google/oauth/start?service=youtube&amp;next=%2Fadmin%2Fgoogle%2Fyoutube"',
    )
    await site.connect(eve, 'ada')
    const [account] = await listAccounts(site.cms(), eve.user.id)
    const notAllowed = await site.screen('/admin/google/youtube', eve.user)
    expect(notAllowed.html).toContain('None of your Google accounts has allowed YouTube yet.')
    expect(notAllowed.html).toContain('manage your YouTube account')
    expect(notAllowed.html).toContain(`account=${account!.id}">Allow YouTube for ada@gmail.com</a>`)
    // Nothing was asked of YouTube for either.
    expect(site.fake.requests.filter((request) => request.path.startsWith('/youtube/'))).toEqual([])
  })

  it('lists the channel’s own videos, a page at a time, in two requests', async () => {
    const { site, owner, account } = await channel()
    const before = site.fake.requests.length
    const page = await site.screen('/admin/google/youtube', owner.user)
    const asked = site.fake.requests.slice(before).map((request) => request.path)
    expect(asked).toEqual([
      '/youtube/v3/channels',
      '/youtube/v3/playlistItems',
      '/youtube/v3/videos',
    ])
    expect(page.html).toContain('Ada Builds')
    expect(page.html).toContain('1,204 subscribers')
    expect(page.html).toContain('Building a CMS in a weekend')
    expect(page.html).toContain('<time>18:42</time>')
    expect(page.html).toContain('src="https://i.ytimg.com/vi/adaVideo001/mqdefault.jpg"')
    expect(page.html).toContain('Goes public 1 December 2026')
    expect(page.html).toContain('12,480')
    expect(page.html.match(/class="row-title"/g)).toHaveLength(25)
    expect(page.html).toContain(`href="/admin/google/youtube?account=${account}&amp;page=t25"`)
    expect(page.html).toContain(`href="/admin/google/youtube/video/adaVideo001?account=${account}"`)
    expect(page.html).not.toContain('Not Ada’s video')
    // No script on this screen: the uploader belongs to the upload screen alone.
    expect(page.html).not.toContain('<script')

    const second = await site.screen('/admin/google/youtube', owner.user, { page: 't25' })
    expect(second.html.match(/class="row-title"/g)).toHaveLength(5)
    expect(second.html).toContain('‹ Newer')
  })

  it('searches the channel when asked, and only then', async () => {
    const { site, owner } = await channel()
    const found = await site.screen('/admin/google/youtube', owner.user, { s: 'weekend' })
    expect(found.html.match(/class="row-title"/g)).toHaveLength(1)
    expect(
      site.fake.requests.filter((request) => request.path === '/youtube/v3/search'),
    ).toHaveLength(1)
    const none = await site.screen('/admin/google/youtube', owner.user, { s: 'zzz' })
    expect(none.html).toContain('No videos found.')
  })

  it('shows only a thumbnail from YouTube’s own image hosts', async () => {
    const { site, owner } = await channel()
    tube(site).videos.get('adaVideo001')!.snippet = {
      ...tube(site).videos.get('adaVideo001')!.snippet,
      ...({ thumbnails: { medium: { url: 'https://evil.test/track.gif' } } } as object),
    }
    const page = await site.screen('/admin/google/youtube', owner.user)
    expect(page.html).not.toContain('evil.test')
  })

  it('says so for an account without a channel, and for a connection Google ended', async () => {
    const none = await channel('linus')
    const page = await none.site.screen('/admin/google/youtube', none.owner.user)
    expect(page.html).toContain('linus@elsewhere.test has no YouTube channel yet.')

    const ended = await channel()
    ended.site.fake.revoke('ada')
    const after = await ended.site.screen('/admin/google/youtube', ended.owner.user)
    expect(after.html).toContain('Google ended this connection. Connect the account again.')
    // The account can't be used now: the screen offers the way back.
    const again = await ended.site.screen('/admin/google/youtube', ended.owner.user)
    expect(again.html).toContain('Connect a Google account to use YouTube here.')
  })

  it('isn’t there when YouTube is switched off', async () => {
    const site = await bootGoogle({ routes: [fakeYouTube], settings: { 'google.youtube': false } })
    const owner = await site.person('ada@cms.test', 'editor')
    await site.connect(owner, 'ada')
    const [account] = await listAccounts(site.cms(), owner.user.id)
    expect((await site.screen('/admin/google/youtube', owner.user)).kind).toBe('not-found')
    const menu = site.kernel
      .adminMenu(owner.user)
      .flatMap((section) => section.items.map((item) => item.url))
    expect(menu).toContain('/admin/google')
    expect(menu).not.toContain('/admin/google/youtube')
    const opened = await site.request('POST', '/api/p/google/youtube/uploads', {
      json: { account: account!.id },
      cookie: owner.cookie,
    })
    expect(opened.status).toBe(404)
    expect(site.fake.requests.filter((request) => request.path.includes('youtube'))).toEqual([])
  })
})

describe('editing a video', () => {
  it('shows one of the channel’s own videos, and no one else’s', async () => {
    const { site, owner } = await channel()
    const page = await site.screen('/admin/google/youtube/video/adaVideo002', owner.user)
    expect(page.title).toBe('Edit “Episode 2”')
    expect(page.html).toContain('value="Episode 2"')
    expect(page.html).toContain('value="2026-12-01T09:00"')
    expect(page.html).toContain('<option value="28" selected="">Science &amp; Technology</option>')
    expect(page.html).not.toContain('Movies')
    expect(page.html).toContain('Weekly episodes')
    expect((await site.screen('/admin/google/youtube/video/otherVideo001', owner.user)).kind).toBe(
      'not-found',
    )
    expect((await site.screen('/admin/google/youtube/video/..%2F..', owner.user)).kind).toBe(
      'not-found',
    )
  })

  it('saves what the form says', async () => {
    const { site, owner, account } = await channel()
    const done = await site.act(owner.cookie, 'youtube-save', {
      ...VALID,
      account,
      video: 'adaVideo003',
      privacy: 'unlisted',
    })
    expect(done.flash).toEqual({ kind: 'notice', message: 'Video updated.' })
    const saved = tube(site).videos.get('adaVideo003')!
    expect(saved.snippet).toMatchObject({
      title: VALID.title,
      tags: ['cms', 'nextjs'],
      categoryId: '28',
    })
    expect(saved.status).toMatchObject({
      privacyStatus: 'unlisted',
      selfDeclaredMadeForKids: false,
    })
  })

  it('refuses a form it can’t take, and changes nothing', async () => {
    const { site, owner, account } = await channel()
    const before = structuredClone(tube(site).videos.get('adaVideo003'))
    const bad = await site.act(owner.cookie, 'youtube-save', {
      ...VALID,
      account,
      video: 'adaVideo003',
      title: '',
    })
    expect(bad.flash!.kind).toBe('error')
    // Someone else's video, by an id typed into the form.
    const other = await site.act(owner.cookie, 'youtube-save', {
      ...VALID,
      account,
      video: 'otherVideo001',
    })
    expect(other.flash).toEqual({
      kind: 'error',
      message: 'That video isn’t on this channel any more.',
    })
    expect(tube(site).videos.get('otherVideo001')!.snippet.title).toBe('Not Ada’s video')
    expect(tube(site).videos.get('adaVideo003')).toEqual(before)
  })

  it('is for the account’s owner: another person’s post with that account does nothing', async () => {
    const { site, account } = await channel()
    const eve = await site.person('eve@cms.test', 'editor')
    for (const name of [
      'youtube-save',
      'youtube-delete',
      'youtube-playlist-add',
      'youtube-playlist-create',
    ]) {
      const refused = await site.act(eve.cookie, name, {
        ...VALID,
        account,
        video: 'adaVideo003',
        sure: 'yes',
        playlist: 'PL-ada-weekly-0001',
      })
      expect({ name, flash: refused.flash }).toEqual({
        name,
        flash: { kind: 'error', message: 'That Google account can’t use YouTube here any more.' },
      })
    }
    expect(tube(site).videos.has('adaVideo003')).toBe(true)
    expect(tube(site).playlists.get('PL-ada-weekly-0001')!.items).toEqual([])
    // And a customer can't post them at all.
    const customer = await site.person('c@cms.test', 'customer')
    expect(
      (
        await site.act(customer.cookie, 'youtube-delete', {
          account,
          video: 'adaVideo003',
          sure: 'yes',
        })
      ).status,
    ).toBe(403)
  })

  it('deletes only when the box is ticked', async () => {
    const { site, owner, account } = await channel()
    const unsure = await site.act(owner.cookie, 'youtube-delete', { account, video: 'adaVideo004' })
    expect(unsure.flash!.message).toBe('Tick the box to say you want the video deleted for good.')
    expect(tube(site).videos.has('adaVideo004')).toBe(true)
    const done = await site.act(owner.cookie, 'youtube-delete', {
      account,
      video: 'adaVideo004',
      sure: 'yes',
    })
    expect(done).toMatchObject({
      path: `/admin/google/youtube?account=${account}`,
      flash: { kind: 'notice', message: '“Episode 4” was deleted from YouTube.' },
    })
    expect(tube(site).videos.has('adaVideo004')).toBe(false)
    const other = await site.act(owner.cookie, 'youtube-delete', {
      account,
      video: 'otherVideo001',
      sure: 'yes',
    })
    expect(other.flash!.kind).toBe('error')
    expect(tube(site).videos.has('otherVideo001')).toBe(true)
  })
})

describe('playlists', () => {
  it('are listed, made, and added to: the account’s own only', async () => {
    const { site, owner, account } = await channel()
    const page = await site.screen('/admin/google/youtube/playlists', owner.user)
    expect(page.html).toContain('Weekly episodes')
    const made = await site.act(owner.cookie, 'youtube-playlist-create', {
      account,
      title: 'Client walkthroughs',
      privacy: 'unlisted',
    })
    expect(made.flash!.message).toBe('The playlist “Client walkthroughs” was made.')
    expect([...tube(site).playlists.values()].map((playlist) => playlist.title)).toContain(
      'Client walkthroughs',
    )
    expect(
      (
        await site.act(owner.cookie, 'youtube-playlist-create', {
          account,
          title: '<b>',
          privacy: 'public',
        })
      ).flash!.kind,
    ).toBe('error')

    const added = await site.act(owner.cookie, 'youtube-playlist-add', {
      account,
      video: 'adaVideo005',
      playlist: 'PL-ada-weekly-0001',
    })
    expect(added.flash!.message).toBe('Added to “Weekly episodes”.')
    expect(tube(site).playlists.get('PL-ada-weekly-0001')!.items).toEqual(['adaVideo005'])
    // A playlist that isn't this account's, by an id typed into the form.
    tube(site).playlists.set('PL-grace-own-00001', {
      id: 'PL-grace-own-00001',
      who: 'grace',
      title: 'Hers',
      privacy: 'public',
      items: [],
    })
    const foreign = await site.act(owner.cookie, 'youtube-playlist-add', {
      account,
      video: 'adaVideo005',
      playlist: 'PL-grace-own-00001',
    })
    expect(foreign.flash).toEqual({ kind: 'error', message: 'Choose one of your playlists.' })
  })
})

describe('uploading', () => {
  const open = (site: GoogleSite, who: Person, body: Record<string, unknown>) =>
    site.request('POST', '/api/p/google/youtube/uploads', { json: body, cookie: who.cookie })

  const file = { name: 'episode-12.mp4', bytes: 20 * 1024 * 1024, type: 'video/mp4' }

  it('shows the form with the uploader, on that screen alone', async () => {
    const { site, owner, account } = await channel()
    const page = await site.screen('/admin/google/youtube/upload', owner.user)
    expect(page.html).toContain('data-google-upload=""')
    expect(page.html).toContain('data-open="/api/p/google/youtube/uploads"')
    expect(page.html).toContain(`name="account" value="${account}"`)
    expect(page.html).toContain('<script src="/api/p/google/upload.js" async=""></script>')
    const script = await site.get('/api/p/google/upload.js')
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(script.headers.get('x-content-type-options')).toBe('nosniff')
    const source = await script.text()
    expect(source).toContain('form[data-google-upload]')
    // The browser's code knows the address it's given, and nothing about tokens.
    expect(source).not.toMatch(/authorization|bearer|access_token/i)
  })

  it('opens an upload at YouTube and hands the browser its address, never a token', async () => {
    const { site, owner, account } = await channel()
    const response = await open(site, owner, {
      ...VALID,
      ...file,
      account,
      playlist: 'PL-ada-weekly-0001',
    })
    expect(response.status).toBe(200)
    const { url, ...rest } = (await response.json()) as { url: string }
    expect(rest).toEqual({})
    expect(url).toMatch(
      new RegExp(
        `^${site.fake.url}/www\\.googleapis\\.com/upload/youtube/v3/videos\\?uploadType=resumable&upload_id=upload\\d+$`,
      ),
    )
    const [upload] = [...tube(site).uploads.values()]
    expect(upload).toMatchObject({
      who: 'ada',
      size: file.bytes,
      type: 'video/mp4',
      origin: 'http://cms.test',
    })
    expect(upload!.metadata.snippet).toMatchObject({ title: VALID.title })
    expect(upload!.metadata.status).toMatchObject({ privacyStatus: 'private' })
    expect(JSON.stringify([url, [...response.headers]])).not.toMatch(/ya29|refresh/)

    // The browser's part: the file in pieces to that address, with no token and no cookie.
    const piece = 8 * 1024 * 1024
    let result: { id?: string } = {}
    for (let offset = 0; offset < file.bytes; offset += piece) {
      const end = Math.min(offset + piece, file.bytes)
      const sent = await fetch(url, {
        method: 'PUT',
        headers: { 'content-range': `bytes ${offset}-${end - 1}/${file.bytes}` },
        body: new Uint8Array(end - offset),
      })
      if (end < file.bytes) {
        expect(sent.status).toBe(308)
        expect(sent.headers.get('range')).toBe(`bytes=0-${end - 1}`)
      } else {
        expect(sent.status).toBe(200)
        result = (await sent.json()) as { id: string }
      }
    }
    expect(result.id).toMatch(/^newVideo\d+$/)

    const done = await site.request('POST', '/api/p/google/youtube/uploads/done', {
      json: { account, id: result.id, playlist: 'PL-ada-weekly-0001' },
      cookie: owner.cookie,
    })
    expect(await done.json()).toEqual({
      redirect: `/admin/google/youtube?account=${account}&uploaded=1`,
    })
    expect(tube(site).playlists.get('PL-ada-weekly-0001')!.items).toEqual([result.id])
    const list = await site.screen('/admin/google/youtube', owner.user, { uploaded: '1' })
    expect(list.html).toContain('The video is at YouTube.')
    expect(list.html).toContain(VALID.title)
  })

  it('doesn’t add someone else’s video to a playlist on the browser’s word', async () => {
    const { site, owner, account } = await channel()
    const done = await site.request('POST', '/api/p/google/youtube/uploads/done', {
      json: { account, id: 'otherVideo001', playlist: 'PL-ada-weekly-0001' },
      cookie: owner.cookie,
    })
    expect(done.status).toBe(200)
    expect(tube(site).playlists.get('PL-ada-weekly-0001')!.items).toEqual([])
  })

  it('refuses what it can’t take, before asking YouTube anything', async () => {
    const { site, owner, account } = await channel()
    const uploads = () => tube(site).uploads.size
    const refused = async (body: Record<string, unknown>, status: number, error: RegExp) => {
      const response = await open(site, owner, { ...VALID, ...file, account, ...body })
      expect({ body, status: response.status }).toEqual({ body, status })
      expect(((await response.json()) as { error: string }).error).toMatch(error)
    }
    await refused({ title: '' }, 400, /Give the video a title/)
    await refused({ type: 'application/x-msdownload' }, 400, /Choose a video file/)
    await refused({ type: 'video/mp4\r\nX-Injected: 1' }, 400, /Choose a video file/)
    await refused({ bytes: 0 }, 400, /up to 256 GB/)
    await refused({ bytes: 300 * 1024 ** 3 }, 400, /up to 256 GB/)
    await refused({ bytes: '20' }, 400, /up to 256 GB/)
    await refused({ playlist: '../x' }, 400, /Choose one of your playlists/)
    await refused({ account: 'not-an-id' }, 404, /can’t use YouTube/)
    expect(uploads()).toBe(0)

    // Not JSON, too large, signed out, and another person naming this account.
    const asForm = await site.request('POST', '/api/p/google/youtube/uploads', {
      form: { account },
      cookie: owner.cookie,
    })
    expect(asForm.status).toBe(415)
    const large = await open(site, owner, {
      ...VALID,
      ...file,
      account,
      description: 'x'.repeat(70_000),
    })
    expect(large.status).toBe(415)
    expect(
      (
        await site.request('POST', '/api/p/google/youtube/uploads', {
          json: { ...VALID, ...file, account },
        })
      ).status,
    ).toBe(403)
    const eve = await site.person('eve@cms.test', 'editor')
    expect((await open(site, eve, { ...VALID, ...file, account })).status).toBe(404)
    const customer = await site.person('c@cms.test', 'customer')
    expect((await open(site, customer, { ...VALID, ...file, account })).status).toBe(403)
    expect(uploads()).toBe(0)
  })

  it('sends the browser only to Google: an answer that names another address is refused', async () => {
    const { site, owner, account } = await channel()
    for (const location of ['https://evil.test/upload', 'http://127.0.0.1:9/elsewhere']) {
      tube(site).location = location
      const response = await open(site, owner, { ...VALID, ...file, account })
      expect({ location, status: response.status }).toEqual({ location, status: 502 })
      expect(JSON.stringify(await response.json())).not.toContain('evil.test')
    }
  })

  it('takes JSON only: text a form on another site could send is not read', async () => {
    const { site, owner, account } = await channel()
    const body = JSON.stringify({ ...VALID, ...file, account })
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const response = await site.request('POST', '/api/p/google/youtube/uploads', {
        body,
        headers: { 'content-type': type },
        cookie: owner.cookie,
      })
      expect({ type, status: response.status }).toEqual({ type, status: 415 })
    }
    expect(tube(site).uploads.size).toBe(0)
  })

  it('says what YouTube said when it won’t open the upload', async () => {
    const { site, owner, account } = await channel()
    site.fake.failNext('/upload/youtube/v3/videos', 429)
    const response = await open(site, owner, { ...VALID, ...file, account })
    expect(response.status).toBe(502)
    expect(((await response.json()) as { error: string }).error).toMatch(/Google’s limit/)
  })
})
