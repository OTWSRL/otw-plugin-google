import { describe, expect, it } from 'vitest'
import { listAccounts } from '../src/accounts'
import { MAX_COPY_BYTES } from '../src/services/drive/actions'
import {
  cleanName,
  cleanQuery,
  folderPath,
  formatBytes,
  getFile,
  googleLink,
  listFiles,
  readFile,
  singleRange,
  storageQuota,
} from '../src/services/drive/client'
import { fakeDrive, pattern, type FakeDrive } from './fake-drive.mjs'
import { bootGoogle, type BootOptions, type GoogleSite, type Person } from './fixtures'

/** A site where Ada has connected her Google account and allowed Drive. */
async function driveSite(options: BootOptions = {}) {
  const site = await bootGoogle({ routes: [fakeDrive], ...options })
  const ada = await site.person('ada@gmail.com')
  expect((await site.connect(ada, 'ada', { service: 'drive' })).outcome).toBe('connected')
  const cms = site.cms()
  const [account] = await listAccounts(cms, ada.user.id)
  const drive = (who = 'ada') => (site.fake.data.drive as Record<string, FakeDrive>)[who]!
  /** The requests the stand-in's Drive got, as `METHOD path?query`. */
  const asked = () =>
    site.fake.requests
      .filter((request) => request.path.startsWith('/drive/'))
      .map((request) => `${request.method} ${request.path}${request.query}`)
  return { site, ada, cms, account: account!.id, drive, asked }
}

/** Posts one of Drive's forms, with fields that may repeat, and reads the message it answers with. */
async function post(site: GoogleSite, who: Person, name: string, fields: [string, string][]) {
  const response = await site.request('POST', `/api/p/google/actions/drive-${name}`, {
    body: new URLSearchParams(fields).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    cookie: who.cookie,
  })
  const location = new URL(response.headers.get('location') ?? '/', 'http://cms.test')
  return {
    status: response.status,
    flash: site.kernel.readFlash(location.searchParams.get('flash') ?? undefined),
  }
}

const fileUrl = (id: string, kind: 'download' | 'preview', account: string) =>
  `/api/p/google/drive/files/${id}/${kind}?account=${account}`

describe('reading Drive', () => {
  it('lists a folder, folders first, with what Drive says checked', async () => {
    const { cms, ada, account } = await driveSite()
    const root = await listFiles(cms, ada.user.id, account, { in: 'root' })
    expect(root.files.map((file) => file.name)).toEqual([
      'Clients',
      'Many',
      'huge.bin',
      "it's a file.txt",
    ])
    expect(root.next).toBeNull()
    const acme = await listFiles(cms, ada.user.id, account, { in: 'acme' })
    const byId = Object.fromEntries(acme.files.map((file) => [file.id, file]))
    expect(byId.episode12).toMatchObject({
      name: 'Episode 12, final cut.mp4',
      kind: 'file',
      size: 2000,
      owner: 'me',
      ownedByMe: true,
      parents: ['acme'],
      trashed: false,
    })
    expect(byId.episode12!.modified).toEqual(new Date('2026-11-25T09:00:00.000Z'))
    expect(byId.raw).toMatchObject({ kind: 'folder', size: null })
    expect(byId.shared).toMatchObject({ owner: 'Grace Hopper', ownedByMe: false })
    // One of Google's documents keeps Google's link; a link that isn't Google's is dropped.
    expect(byId.plan).toMatchObject({
      kind: 'google',
      size: null,
      viewLink: 'https://docs.google.com/document/d/plan/edit',
    })
    expect(byId.trap).toMatchObject({ kind: 'google', viewLink: null })
  })

  it('pages through a long folder with Google’s token', async () => {
    const { cms, ada, account } = await driveSite()
    const first = await listFiles(cms, ada.user.id, account, { in: 'many' })
    expect(first.files).toHaveLength(50)
    expect(first.next).toBe('page:50')
    const second = await listFiles(cms, ada.user.id, account, { in: 'many' }, first.next)
    expect(second.files.map((file) => file.name).at(-1)).toBe('file 60.txt')
    expect(second).toMatchObject({ next: null })
    expect(second.files).toHaveLength(10)
    // A token longer than any of Google's isn't sent.
    const long = await listFiles(cms, ada.user.id, account, { in: 'many' }, 'x'.repeat(5000))
    expect(long.files).toHaveLength(50)
  })

  it('searches by name, and keeps what is typed inside the quotes of Drive’s search', async () => {
    const { cms, ada, account, asked } = await driveSite()
    const found = await listFiles(cms, ada.user.id, account, { search: "it's a" })
    expect(found.files.map((file) => file.id)).toEqual(['quote'])
    // Words that would end the string and add a clause of their own find nothing, and no error.
    for (const words of [
      "x' or trashed = true or name contains '",
      "\\' or trashed = true or '",
      '\\',
    ]) {
      const none = await listFiles(cms, ada.user.id, account, { search: words })
      expect({ words, files: none.files }).toEqual({ words, files: [] })
    }
    // The trashed file stays out of a search, and is what the trash lists.
    expect((await listFiles(cms, ada.user.id, account, { search: 'old' })).files).toEqual([])
    const trash = await listFiles(cms, ada.user.id, account, { trash: true })
    expect(trash.files.map((file) => file.id)).toEqual(['old'])
    expect(asked().every((line) => line.startsWith('GET /drive/v3/files?q='))).toBe(true)
  })

  it('never sends an id that can’t be one', async () => {
    const { cms, ada, account, asked } = await driveSite()
    const before = asked().length
    for (const id of ["a' or 'b", '../about', '', 'x'.repeat(201), 'a b', 'a/b']) {
      await expect(listFiles(cms, ada.user.id, account, { in: id })).rejects.toMatchObject({
        kind: 'not_found',
      })
      await expect(getFile(cms, ada.user.id, account, id)).rejects.toMatchObject({
        kind: 'not_found',
      })
      await expect(readFile(cms, ada.user.id, account, id, 10)).rejects.toMatchObject({
        kind: 'not_found',
      })
    }
    expect(asked()).toHaveLength(before)
  })

  it('follows a folder’s parents up for its breadcrumbs', async () => {
    const { cms, ada, account } = await driveSite()
    const path = await folderPath(cms, ada.user.id, account, 'raw')
    expect(path.complete).toBe(true)
    expect(path.folders.map((folder) => folder.name)).toEqual([
      'My Drive',
      'Clients',
      'Acme',
      'Raw footage',
    ])
  })

  it('stops following parents after a few levels, and says so', async () => {
    const { cms, ada, account, drive, asked } = await driveSite()
    const files = drive().files
    let parent = 'acme'
    for (let level = 1; level <= 12; level++) {
      files[`deep-${level}`] = {
        ...files.raw!,
        id: `deep-${level}`,
        name: `Level ${level}`,
        parents: [parent],
      }
      parent = `deep-${level}`
    }
    const before = asked().length
    const path = await folderPath(cms, ada.user.id, account, 'deep-12')
    expect(path.complete).toBe(false)
    expect(path.folders).toHaveLength(8)
    expect(path.folders.at(-1)!.name).toBe('Level 12')
    expect(asked()).toHaveLength(before + 8)
  })

  it('reads how much of the account’s storage is used', async () => {
    const { cms, ada, account, drive } = await driveSite()
    expect(await storageQuota(cms, ada.user.id, account)).toEqual({
      used: 10522669875,
      limit: 16106127360,
    })
    // An account with no limit, and an answer that isn't numbers.
    drive().quota = { usage: '12' }
    expect(await storageQuota(cms, ada.user.id, account)).toEqual({ used: 12, limit: null })
    drive().quota = { usage: 'lots' }
    expect(await storageQuota(cms, ada.user.id, account)).toBeNull()
  })

  it('reads a file whole only up to a limit, kept while reading', async () => {
    const { cms, ada, account } = await driveSite()
    const whole = await readFile(cms, ada.user.id, account, 'episode12', 5000)
    expect(Buffer.from(whole!).equals(pattern(2000))).toBe(true)
    expect(await readFile(cms, ada.user.id, account, 'episode12', 2000)).not.toBeNull()
    expect(await readFile(cms, ada.user.id, account, 'episode12', 1999)).toBeNull()
  })

  it('sees only the account’s own Drive', async () => {
    const { cms, ada, account } = await driveSite()
    await expect(getFile(cms, ada.user.id, account, 'grace-private')).rejects.toMatchObject({
      kind: 'not_found',
    })
  })

  it('takes what a file says about itself as text to check', async () => {
    const { cms, ada, account, drive } = await driveSite()
    const files = drive().files
    files.odd = {
      ...files.notes!,
      id: 'odd',
      name: `line one\r\nline two\u0000 ${'x'.repeat(400)}`,
      size: '-5',
      modifiedTime: 'yesterday',
      parents: ['acme', '../../etc', 'has space'],
      owners: 'nobody' as never,
      ownedByMe: 'yes' as never,
    }
    const file = await getFile(cms, ada.user.id, account, 'odd')
    expect(file.name).toHaveLength(255)
    expect(file.name.startsWith('line one line two')).toBe(true)
    expect(file).toMatchObject({
      size: null,
      modified: null,
      parents: ['acme'],
      owner: '',
      ownedByMe: false,
    })
    // An entry whose id can't be one is left out of a list.
    files['bad id'] = { ...files.notes!, id: 'bad id' }
    const acme = await listFiles(cms, ada.user.id, account, { in: 'acme' })
    expect(acme.files.some((item) => item.id === 'bad id')).toBe(false)
  })
})

describe('Drive’s small helpers', () => {
  it('take a link only when it is Google’s own, over https', () => {
    expect(googleLink('https://docs.google.com/document/d/1/edit')).toBe(
      'https://docs.google.com/document/d/1/edit',
    )
    expect(googleLink('https://drive.google.com/file/d/1/view')).not.toBeNull()
    for (const link of [
      'http://docs.google.com/document/d/1',
      'javascript:alert(1)',
      'https://docs.google.com.evil.test/',
      'https://evil.test/docs.google.com',
      'https://notgoogle.com/',
      'https://google.com@evil.test/',
      'https://user:pass@docs.google.com/',
      '//docs.google.com/x',
      `https://docs.google.com/${'x'.repeat(2100)}`,
      '',
      null,
      7,
    ]) {
      expect({ link, kept: googleLink(link) }).toEqual({ link, kept: null })
    }
  })

  it('pass on one plain range and nothing else', () => {
    expect(singleRange('bytes=0-99')).toBe('bytes=0-99')
    expect(singleRange('bytes=100-')).toBe('bytes=100-')
    expect(singleRange('bytes=-500')).toBe('bytes=-500')
    for (const header of [
      null,
      '',
      'bytes=0-1,5-9',
      'bytes=-',
      'items=0-5',
      'bytes=0-9\r\nx: y',
      `bytes=${'1'.repeat(40)}-`,
    ]) {
      expect(singleRange(header)).toBeNull()
    }
  })

  it('clean a name and a search to one short line', () => {
    expect(cleanName('  Plans\r\n2027\u0000 ')).toBe('Plans 2027')
    expect(cleanName('x'.repeat(400))).toHaveLength(255)
    expect(cleanName(' \n ')).toBe('')
    expect(cleanQuery(`  budget\t${'y'.repeat(400)}`)).toHaveLength(200)
  })

  it('write sizes as people read them', () => {
    expect(formatBytes(0)).toBe('0 bytes')
    expect(formatBytes(240 * 1024)).toBe('240 KB')
    expect(formatBytes(1.8 * 1024 * 1024)).toBe('1.8 MB')
    expect(formatBytes(512 * 1024 * 1024)).toBe('512 MB')
    expect(formatBytes(15 * 1024 ** 3)).toBe('15 GB')
  })
})

describe('the Drive screen’s forms', () => {
  it('make a folder where the person is, with a name on one line', async () => {
    const { site, ada, account, drive } = await driveSite()
    const done = await post(site, ada, 'new-folder', [
      ['account', account],
      ['parent', 'acme'],
      ['name', '  Plans\r\n2027  '],
    ])
    expect(done.flash).toEqual({ kind: 'notice', message: 'The folder “Plans 2027” was made.' })
    const made = Object.values(drive().files).find((file) => file.name === 'Plans 2027')!
    expect(made).toMatchObject({
      parents: ['acme'],
      mimeType: 'application/vnd.google-apps.folder',
    })
    // No parent named: the top folder.
    await post(site, ada, 'new-folder', [
      ['account', account],
      ['name', 'At the top'],
    ])
    expect(
      Object.values(drive().files).find((file) => file.name === 'At the top')!.parents,
    ).toEqual(['root-ada'])
    const long = await post(site, ada, 'new-folder', [
      ['account', account],
      ['name', 'n'.repeat(400)],
    ])
    expect(long.flash!.kind).toBe('notice')
    expect(Object.values(drive().files).some((file) => file.name === 'n'.repeat(255))).toBe(true)
  })

  it('refuse a folder with no name, or in a place that can’t be one', async () => {
    const { site, ada, account, drive, asked } = await driveSite()
    const count = Object.keys(drive().files).length
    const before = asked().length
    expect(
      (
        await post(site, ada, 'new-folder', [
          ['account', account],
          ['name', ' \n '],
        ])
      ).flash,
    ).toEqual({
      kind: 'error',
      message: 'Give the folder a name.',
    })
    const bad = await post(site, ada, 'new-folder', [
      ['account', account],
      ['parent', "x' or 'y"],
      ['name', 'Plans'],
    ])
    expect(bad.flash).toEqual({ kind: 'error', message: 'That folder isn’t in Drive any more.' })
    expect(Object.keys(drive().files)).toHaveLength(count)
    expect(asked()).toHaveLength(before)
  })

  it('rename a file', async () => {
    const { site, ada, account, drive } = await driveSite()
    const done = await post(site, ada, 'rename', [
      ['account', account],
      ['id', 'notes'],
      ['name', 'Notes for Thursday.txt'],
    ])
    expect(done.flash).toEqual({ kind: 'notice', message: 'Renamed to “Notes for Thursday.txt”.' })
    expect(drive().files.notes!.name).toBe('Notes for Thursday.txt')
    expect(
      (
        await post(site, ada, 'rename', [
          ['account', account],
          ['id', 'notes'],
          ['name', ''],
        ])
      ).flash,
    ).toEqual({
      kind: 'error',
      message: 'Give it a name.',
    })
    expect(
      (
        await post(site, ada, 'rename', [
          ['account', account],
          ['id', 'no/such'],
          ['name', 'x'],
        ])
      ).flash,
    ).toEqual({
      kind: 'error',
      message: 'That file isn’t in Drive any more.',
    })
  })

  it('move files to the trash and back, one or several, and say how many', async () => {
    const { site, ada, account, drive } = await driveSite()
    const one = await post(site, ada, 'trash', [
      ['account', account],
      ['ids', 'notes'],
    ])
    expect(one.flash).toEqual({ kind: 'notice', message: '1 file moved to the trash.' })
    expect(drive().files.notes!.trashed).toBe(true)
    const several = await post(site, ada, 'trash', [
      ['account', account],
      ['ids', 'thumb'],
      ['ids', 'contract'],
      ['ids', 'thumb'],
    ])
    expect(several.flash).toEqual({ kind: 'notice', message: '2 files moved to the trash.' })
    const back = await post(site, ada, 'restore', [
      ['account', account],
      ['ids', 'notes'],
      ['ids', 'thumb'],
      ['ids', 'contract'],
    ])
    expect(back.flash).toEqual({ kind: 'notice', message: '3 files restored.' })
    expect(
      [drive().files.notes, drive().files.thumb, drive().files.contract].map(
        (file) => file!.trashed,
      ),
    ).toEqual([false, false, false])
  })

  it('say what couldn’t be moved, and why, when Google refuses a file', async () => {
    const { site, ada, account, drive } = await driveSite()
    const mixed = await post(site, ada, 'trash', [
      ['account', account],
      ['ids', 'notes'],
      ['ids', 'shared'],
    ])
    expect(mixed.flash).toEqual({
      kind: 'notice',
      message:
        '1 file moved to the trash; 1 couldn’t be: Google doesn’t let this account change that. It may belong to someone else.',
    })
    const none = await post(site, ada, 'trash', [
      ['account', account],
      ['ids', 'shared'],
    ])
    expect(none.flash).toEqual({
      kind: 'error',
      message: 'Google doesn’t let this account change that. It may belong to someone else.',
    })
    expect(drive().files.shared!.trashed).toBe(false)
  })

  it('refuse a list of files that is empty, too long, or holds an id that can’t be one', async () => {
    const { site, ada, account, drive, asked } = await driveSite()
    const before = asked().length
    expect((await post(site, ada, 'trash', [['account', account]])).flash!.message).toBe(
      'Tick the files first.',
    )
    const many: [string, string][] = Array.from({ length: 51 }, (_, index) => [
      'ids',
      `many-${String(index + 1).padStart(2, '0')}`,
    ])
    expect((await post(site, ada, 'trash', [['account', account], ...many])).flash!.message).toBe(
      'Choose 50 files or fewer at a time.',
    )
    const bad = await post(site, ada, 'trash', [
      ['account', account],
      ['ids', 'notes'],
      ['ids', '../about'],
    ])
    expect(bad.flash!.message).toBe('One of those files isn’t in Drive any more.')
    expect(asked()).toHaveLength(before)
    expect(drive().files.notes!.trashed).toBe(false)
  })

  it('work only on the person’s own account that has allowed Drive', async () => {
    const { site, ada, account, drive, asked } = await driveSite()
    const eve = await site.person('eve@cms.test', 'editor')
    await site.connect(eve, 'grace', { service: 'drive' })
    // Ada's second account, which hasn't allowed Drive.
    await site.connect(ada, 'linus')
    const second = (await listAccounts(site.cms(), ada.user.id)).find(
      (item) => item.email === 'linus@elsewhere.test',
    )!
    const before = asked().length
    const refused = { kind: 'error', message: 'That Google account can’t use Drive here.' }
    const forms: [string, [string, string][]][] = [
      ['trash', [['ids', 'notes']]],
      ['restore', [['ids', 'old']]],
      [
        'rename',
        [
          ['id', 'notes'],
          ['name', 'Mine now.txt'],
        ],
      ],
      ['new-folder', [['name', 'Eve was here']]],
      ['to-media', [['id', 'notes']]],
    ]
    for (const [name, fields] of forms) {
      // Someone else's account, the person's own without Drive, none, and one that doesn't exist.
      expect((await post(site, eve, name, [['account', account], ...fields])).flash).toEqual(
        refused,
      )
      expect((await post(site, ada, name, [['account', second.id], ...fields])).flash).toEqual(
        refused,
      )
      expect((await post(site, ada, name, fields)).flash).toEqual(refused)
      expect((await post(site, ada, name, [['account', 'not-an-id'], ...fields])).flash).toEqual(
        refused,
      )
    }
    expect(asked()).toHaveLength(before)
    expect(drive().files.notes).toMatchObject({ name: 'notes.txt', trashed: false })
    // And someone who may not use Google at all never reaches an action.
    const customer = await site.person('c@cms.test', 'customer')
    expect(
      (
        await post(site, customer, 'trash', [
          ['account', account],
          ['ids', 'notes'],
        ])
      ).status,
    ).toBe(403)
    expect(drive().files.notes!.trashed).toBe(false)
  })

  it('copy a file to the Media library, for people who may add files there', async () => {
    const { site, ada, account, cms } = await driveSite()
    const done = await post(site, ada, 'to-media', [
      ['account', account],
      ['id', 'notes'],
    ])
    expect(done.flash).toEqual({
      kind: 'notice',
      message: '“notes.txt” is in the Media library now.',
    })
    const { items } = await cms.media.list()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ filename: 'notes.txt', authorId: ada.user.id, size: 23 })
  })

  it('copy nothing that is too large, that has no bytes, or that the library won’t take', async () => {
    const { site, ada, account, cms, asked } = await driveSite()
    const before = asked().filter((line) => line.includes('alt=media')).length
    const large = await post(site, ada, 'to-media', [
      ['account', account],
      ['id', 'huge'],
    ])
    expect(large.flash).toEqual({
      kind: 'error',
      message: 'Only files up to 32 MB can be copied to the Media library from here.',
    })
    expect(MAX_COPY_BYTES).toBe(32 * 1024 * 1024)
    for (const id of ['plan', 'raw']) {
      expect(
        (
          await post(site, ada, 'to-media', [
            ['account', account],
            ['id', id],
          ])
        ).flash,
      ).toEqual({
        kind: 'error',
        message: 'Only files can be copied: a folder or a Google document has no file.',
      })
    }
    // Nothing was downloaded for any of them.
    expect(asked().filter((line) => line.includes('alt=media'))).toHaveLength(before)
    // The library's own word on a type it doesn't take is passed on.
    const html = await post(site, ada, 'to-media', [
      ['account', account],
      ['id', 'page'],
    ])
    expect(html.flash!.kind).toBe('error')
    expect((await cms.media.list()).items).toEqual([])
  })

  it('stop copying a file that turns out larger than Drive said it was', async () => {
    const { site, ada, account, cms, drive } = await driveSite()
    drive().files.liar = {
      ...drive().files.notes!,
      id: 'liar',
      name: 'small.txt',
      size: '10',
      content: Buffer.alloc(MAX_COPY_BYTES + 1, 'a').toString('base64'),
    }
    const done = await post(site, ada, 'to-media', [
      ['account', account],
      ['id', 'liar'],
    ])
    expect(done.flash).toEqual({
      kind: 'error',
      message: 'Only files up to 32 MB can be copied to the Media library from here.',
    })
    expect((await cms.media.list()).items).toEqual([])
  })

  it('leave the Media library to those who may add to it', async () => {
    const { site, cms } = await driveSite()
    // A Google user may use Drive, and may not upload to the library.
    const guest = await site.person('guest@cms.test', 'google_user')
    await site.connect(guest, 'grace', { service: 'drive' })
    const [own] = await listAccounts(cms, guest.user.id)
    const done = await post(site, guest, 'to-media', [
      ['account', own!.id],
      ['id', 'grace-private'],
    ])
    expect(done.flash).toEqual({
      kind: 'error',
      message: 'You may not add files to the Media library.',
    })
    expect((await cms.media.list()).items).toEqual([])
  })
})

describe('a file’s bytes', () => {
  it('download as an attachment, streamed from Google with its length', async () => {
    const { site, ada, account } = await driveSite()
    const response = await site.get(fileUrl('episode12', 'download', account), ada.cookie)
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer()).equals(pattern(2000))).toBe(true)
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'content-type': 'application/octet-stream',
      'content-disposition':
        'attachment; filename="Episode 12, final cut.mp4"; filename*=UTF-8\'\'Episode%2012%2C%20final%20cut.mp4',
      'content-length': '2000',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
      'accept-ranges': 'bytes',
      'referrer-policy': 'no-referrer',
    })
  })

  it('answer one range of bytes, and ignore a range that isn’t one', async () => {
    const { site, ada, account } = await driveSite()
    const part = await site.request('GET', fileUrl('episode12', 'download', account), {
      cookie: ada.cookie,
      headers: { range: 'bytes=10-19' },
    })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 10-19/2000')
    expect(part.headers.get('content-length')).toBe('10')
    expect(Buffer.from(await part.arrayBuffer()).equals(pattern(2000).subarray(10, 20))).toBe(true)
    for (const range of ['bytes=0-1,5-9', 'items=0-5', 'bytes=-']) {
      const whole = await site.request('GET', fileUrl('episode12', 'download', account), {
        cookie: ada.cookie,
        headers: { range },
      })
      expect({ range, status: whole.status }).toEqual({ range, status: 200 })
      expect((await whole.arrayBuffer()).byteLength).toBe(2000)
    }
    // Google was sent the one good range and no other.
    const ranges = site.fake.requests
      .filter((request) => request.query.includes('alt=media'))
      .map((request) => request.headers.range)
    expect(ranges).toEqual(['bytes=10-19', undefined, undefined, undefined])
  })

  it('show in the browser only types that can run nothing: the rest download', async () => {
    const { site, ada, account } = await driveSite()
    const shown: [string, string][] = [
      ['thumb', 'image/png'],
      ['contract', 'application/pdf'],
      ['notes', 'text/plain; charset=utf-8'],
      ['episode12', 'video/mp4'],
    ]
    for (const [id, type] of shown) {
      const response = await site.get(fileUrl(id, 'preview', account), ada.cookie)
      expect({ id, type: response.headers.get('content-type') }).toEqual({ id, type })
      expect(response.headers.get('content-disposition')).toMatch(/^inline; /)
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    }
    // HTML and SVG would run as this site: they are only ever saved, whatever they're asked as.
    for (const id of ['page', 'logo', 'huge']) {
      const response = await site.get(fileUrl(id, 'preview', account), ada.cookie)
      expect({ id, type: response.headers.get('content-type') }).toEqual({
        id,
        type: 'application/octet-stream',
      })
      expect(response.headers.get('content-disposition')).toMatch(/^attachment; /)
      expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    }
  })

  it('take the type from this site’s list, not from what the file calls itself', async () => {
    const { site, ada, account, drive } = await driveSite()
    drive().files.page!.mimeType = 'TEXT/HTML; charset=utf-8'
    drive().files.logo!.mimeType = 'image/png\r\nx-injected: 1'
    for (const id of ['page', 'logo']) {
      const response = await site.get(fileUrl(id, 'preview', account), ada.cookie)
      expect(response.headers.get('content-type')).toBe('application/octet-stream')
      expect(response.headers.get('x-injected')).toBeNull()
    }
    // A type from the list in capitals is the same type.
    drive().files.thumb!.mimeType = 'IMAGE/PNG'
    const upper = await site.get(fileUrl('thumb', 'preview', account), ada.cookie)
    expect(upper.headers.get('content-type')).toBe('image/png')
  })

  it('name the download safely, whatever the file is called', async () => {
    const { site, ada, account, drive } = await driveSite()
    drive().files.notes!.name = 'résumé "final"\r\nSet-Cookie: x=1 \\ /etc.txt'
    const response = await site.get(fileUrl('notes', 'download', account), ada.cookie)
    const header = response.headers.get('content-disposition')!
    expect(header).toBe(
      'attachment; filename="r_sum_ _final_ Set-Cookie: x=1 _ _etc.txt"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9%20%22final%22%20Set-Cookie%3A%20x%3D1%20_%20_etc.txt',
    )
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('are for the signed-in owner of an account that has allowed Drive', async () => {
    const { site, ada, account, asked } = await driveSite()
    const eve = await site.person('eve@cms.test', 'editor')
    await site.connect(eve, 'grace', { service: 'drive' })
    const [eves] = await listAccounts(site.cms(), eve.user.id)
    const customer = await site.person('c@cms.test', 'customer')
    const before = asked().length
    for (const kind of ['download', 'preview'] as const) {
      expect((await site.get(fileUrl('notes', kind, account))).status).toBe(401)
      expect((await site.get(fileUrl('notes', kind, account), customer.cookie)).status).toBe(403)
      // Someone else's account, no account, and an id that can't be a file's.
      expect((await site.get(fileUrl('notes', kind, account), eve.cookie)).status).toBe(404)
      expect((await site.get(`/api/p/google/drive/files/notes/${kind}`, ada.cookie)).status).toBe(
        404,
      )
      expect((await site.get(fileUrl('a%27b', kind, account), ada.cookie)).status).toBe(404)
    }
    expect(asked()).toHaveLength(before)
    // Her own account reaches her own Drive only: Ada's file isn't in it.
    expect((await site.get(fileUrl('notes', 'download', eves!.id), eve.cookie)).status).toBe(404)
    expect(
      (await site.get(fileUrl('grace-private', 'download', eves!.id), eve.cookie)).status,
    ).toBe(200)
  })

  it('say so for a folder or a Google document, which have no bytes', async () => {
    const { site, ada, account, asked } = await driveSite()
    for (const id of ['raw', 'plan']) {
      const response = await site.get(fileUrl(id, 'download', account), ada.cookie)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: 'That has no file to download. Open it in Google Drive.',
      })
    }
    expect(asked().some((line) => line.includes('alt=media'))).toBe(false)
  })

  it('answer Google’s troubles in this site’s own words, never Google’s', async () => {
    const { site, ada, account } = await driveSite()
    site.fake.failNext('/drive/v3/files/notes', 400)
    const refused = await site.get(fileUrl('notes', 'download', account), ada.cookie)
    expect(refused.status).toBe(400)
    expect(await refused.json()).toEqual({ error: 'Google refused that.' })

    site.fake.failNext('/drive/v3/files/notes', 503, { times: 3 })
    const down = await site.get(fileUrl('notes', 'download', account), ada.cookie)
    expect(down.status).toBe(502)
    expect(await down.json()).toEqual({ error: 'Google had a problem. Try again in a moment.' })

    site.fake.revoke('ada')
    site.fake.expireAccessTokens()
    const ended = await site.get(fileUrl('notes', 'download', account), ada.cookie)
    expect(ended.status).toBe(409)
    // And from then on the account can't use Drive until it's connected again.
    expect((await site.get(fileUrl('notes', 'download', account), ada.cookie)).status).toBe(404)
  })
})

describe('with Drive switched off', () => {
  it('has no screen, and its addresses and forms do nothing', async () => {
    const { site, ada, account } = await driveSite()
    const off = await bootGoogle({ routes: [fakeDrive], settings: { 'google.drive': false } })
    const bob = await off.person('bob@cms.test')
    expect((await off.screen('/admin/google/drive', bob.user)).kind).toBe('not-found')
    const menu = off.kernel
      .adminMenu(bob.user)
      .flatMap((section) => section.items.map((item) => item.label))
    expect(menu).not.toContain('Drive')
    expect(
      (
        await post(off, bob, 'trash', [
          ['account', account],
          ['ids', 'notes'],
        ])
      ).status,
    ).toBe(404)
    // Switched on, the screen and the menu entry are there.
    expect((await site.screen('/admin/google/drive', ada.user)).kind).toBe('page')
    expect(
      site.kernel.adminMenu(ada.user).flatMap((section) => section.items.map((item) => item.label)),
    ).toContain('Drive')
  })

  it('refuses a file’s bytes even to an account that allowed Drive before', async () => {
    const site = await bootGoogle({ routes: [fakeDrive] })
    const ada = await site.person('ada@gmail.com')
    await site.connect(ada, 'ada', { service: 'drive' })
    const [account] = await listAccounts(site.cms(), ada.user.id)
    expect((await site.get(fileUrl('notes', 'download', account!.id), ada.cookie)).status).toBe(200)
    // The same database, with the service switched off.
    await site.db.execute(
      `INSERT INTO cms_settings (key, value) VALUES ('google.drive', 'false')` as never,
    )
    const kernel = await site.reboot()
    const response = await kernel.handleApi(
      new Request(`http://cms.test${fileUrl('notes', 'download', account!.id)}`, {
        headers: { cookie: ada.cookie },
      }),
    )
    expect(response.status).toBe(404)
  })
})
