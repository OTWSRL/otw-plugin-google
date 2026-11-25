import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { listAccounts } from '../src/accounts'
import { bootGoogle, type GoogleSite } from './fixtures'
import { fakeDrive, pattern, type FakeDrive } from './fake-drive.mjs'
import { fakeYouTube, type FakeYouTubeData } from './fake-youtube.mjs'

const tube = (site: GoogleSite) => site.fake.data.youtube as FakeYouTubeData
const driveOf = (site: GoogleSite, who = 'ada') =>
  (site.fake.data.drive as Record<string, FakeDrive>)[who]!

/** A site where Ada's Google account has allowed both YouTube and Drive for an editor. */
async function both(services = ['youtube', 'drive']) {
  const site = await bootGoogle({ routes: [fakeYouTube, fakeDrive] })
  const owner = await site.person('ada@cms.test', 'editor')
  await site.connect(owner, 'ada')
  const [account] = await listAccounts(site.cms(), owner.user.id)
  for (const service of services)
    await site.connect(owner, 'ada', { service, account: account!.id })
  return { site, owner, account: account!.id }
}

const VALID = {
  title: 'Episode 12: the final cut',
  description: '',
  tags: '',
  category: '28',
  privacy: 'private',
  kids: 'no',
}

/** Runs queued jobs until none is due, and says how many ran. */
async function runJobs(site: GoogleSite): Promise<number> {
  let ran = 0
  for (let round = 0; round < 50; round++) {
    const done = await site.kernel.jobs.runDue()
    ran += done.ran
    if (done.ran === 0) break
  }
  return ran
}

const copyJobs = async (site: GoogleSite) =>
  (
    (await site.db.execute(
      sql`SELECT status, args::text AS args FROM cms_jobs WHERE name = 'google.youtube_from_drive' ORDER BY created_at`,
    )) as unknown as { rows: { status: string; args: string }[] }
  ).rows

describe('sending a Drive video to YouTube', () => {
  it('shows the Drive file as the source, with a plain form and no script', async () => {
    const { site, owner, account } = await both()
    const page = await site.screen('/admin/google/youtube/upload', owner.user, {
      drive: 'episode12',
    })
    expect(page.html).toContain('From Google Drive: Episode 12, final cut.mp4')
    expect(page.html).toContain('action="/api/p/google/actions/youtube-from-drive"')
    expect(page.html).toContain('name="drive" value="episode12"')
    expect(page.html).toContain(`name="account" value="${account}"`)
    // The title starts as the file's name without its ending.
    expect(page.html).toContain('value="Episode 12, final cut"')
    expect(page.html).not.toContain('<script')
    expect(page.html).not.toContain('data-google-upload')

    const notVideo = await site.screen('/admin/google/youtube/upload', owner.user, {
      drive: 'notes',
    })
    expect(notVideo.html).toContain('notes.txt in Google Drive isn’t a video YouTube can take.')
    expect(notVideo.html).not.toContain('Copy to YouTube')
    // An id that can't be one is ignored: the ordinary upload form.
    const bad = await site.screen('/admin/google/youtube/upload', owner.user, { drive: '../x' })
    expect(bad.html).toContain('data-google-upload')
  })

  it('says so when the account hasn’t allowed Drive', async () => {
    const { site, owner, account } = await both(['youtube'])
    const page = await site.screen('/admin/google/youtube/upload', owner.user, {
      drive: 'episode12',
    })
    expect(page.html).toContain('This account hasn’t allowed Drive, so the file can’t be read.')
    const refused = await site.act(owner.cookie, 'youtube-from-drive', {
      ...VALID,
      account,
      drive: 'episode12',
    })
    expect(refused.flash).toEqual({
      kind: 'error',
      message: 'That Google account needs to allow both YouTube and Drive first.',
    })
    expect(await copyJobs(site)).toEqual([])
  })

  it('queues the copy, and a background job sends the file to YouTube', async () => {
    const { site, owner, account } = await both()
    const done = await site.act(owner.cookie, 'youtube-from-drive', {
      ...VALID,
      account,
      drive: 'episode12',
      playlist: 'PL-ada-weekly-0001',
    })
    expect(done.path).toBe(`/admin/google/youtube?account=${account}`)
    expect(done.flash!.message).toMatch(/^The copy from Drive has started\./)
    // Nothing went to YouTube in the request itself.
    expect(tube(site).uploads.size).toBe(0)

    expect(await runJobs(site)).toBe(1)
    const [upload] = [...tube(site).uploads.values()]
    expect(upload).toMatchObject({
      who: 'ada',
      size: 2000,
      type: 'video/mp4',
      received: 2000,
      origin: null,
    })
    const made = [...tube(site).videos.values()].find(
      (video) => video.snippet.title === VALID.title,
    )!
    expect(made.status.privacyStatus).toBe('private')
    expect(tube(site).playlists.get('PL-ada-weekly-0001')!.items).toEqual([made.id])
    expect((await copyJobs(site)).map((job) => job.status)).toEqual(['done'])
  })

  it('copies a large file a piece at a time, over several runs, without keeping YouTube’s address in the clear', async () => {
    const { site, owner, account } = await both()
    const size = 3 * 256 * 1024 + 1000
    driveOf(site).files.big = {
      ...driveOf(site).files.episode12!,
      id: 'big',
      name: 'Long cut.mp4',
      content: pattern(size).toString('base64'),
    }
    await site.cms().jobs.enqueue('google.youtube_from_drive', {
      userId: owner.user.id,
      accountId: account,
      fileId: 'big',
      changes: {
        title: 'Long cut',
        description: '',
        tags: [],
        categoryId: '28',
        privacy: 'private',
        publishAt: null,
        madeForKids: false,
      },
      playlist: null,
      bytes: size,
      type: 'video/mp4',
      // One small piece per run, so the copy has to pick up where it left off.
      piece: 256 * 1024,
      budgetMs: 0,
    })
    expect(await runJobs(site)).toBe(4)
    const [upload] = [...tube(site).uploads.values()]
    expect(upload!.received).toBe(size)
    expect(
      [...tube(site).videos.values()].some((video) => video.snippet.title === 'Long cut'),
    ).toBe(true)
    // Drive was asked for exactly the pieces, in order.
    const ranges = site.fake.requests
      .filter(
        (request) => request.path === '/drive/v3/files/big' && request.query.includes('alt=media'),
      )
      .map((request) => request.headers.range)
    expect(ranges).toEqual([
      'bytes=0-262143',
      'bytes=262144-524287',
      'bytes=524288-786431',
      `bytes=786432-${size - 1}`,
    ])
    // Between runs the job carries YouTube's address for the upload encrypted, never as it is.
    const jobs = await copyJobs(site)
    expect(jobs).toHaveLength(4)
    for (const job of jobs.slice(1)) {
      expect(job.args).toContain('"session": "v1.')
      expect(job.args).not.toContain('upload_id=')
    }
  })

  it('is for the person’s own account and a video of their own Drive', async () => {
    const { site, owner, account } = await both()
    const eve = await site.person('eve@cms.test', 'editor')
    const other = await site.act(eve.cookie, 'youtube-from-drive', {
      ...VALID,
      account,
      drive: 'episode12',
    })
    expect(other.flash!.kind).toBe('error')
    const notVideo = await site.act(owner.cookie, 'youtube-from-drive', {
      ...VALID,
      account,
      drive: 'notes',
    })
    expect(notVideo.flash).toEqual({ kind: 'error', message: 'That Drive file isn’t a video.' })
    const missing = await site.act(owner.cookie, 'youtube-from-drive', {
      ...VALID,
      account,
      drive: 'no-such-file',
    })
    expect(missing.flash!.kind).toBe('error')
    const badTitle = await site.act(owner.cookie, 'youtube-from-drive', {
      ...VALID,
      title: '',
      account,
      drive: 'episode12',
    })
    expect(badTitle.flash!.kind).toBe('error')
    expect(await copyJobs(site)).toEqual([])
  })

  it('fails its job when Drive no longer has the file, so the queue can say so', async () => {
    const { site, owner, account } = await both()
    await site.act(owner.cookie, 'youtube-from-drive', { ...VALID, account, drive: 'episode12' })
    delete driveOf(site).files.episode12
    await runJobs(site)
    const [job] = await copyJobs(site)
    expect(job!.status).not.toBe('done')
    expect(
      [...tube(site).videos.values()].some((video) => video.snippet.title === VALID.title),
    ).toBe(false)
  })
})
