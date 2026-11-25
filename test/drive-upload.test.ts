import { describe, expect, it } from 'vitest'
import { listAccounts } from '../src/accounts'
import { bootGoogle, type GoogleSite, type Person } from './fixtures'
import { fakeDrive, type FakeDrive } from './fake-drive.mjs'

const driveOf = (site: GoogleSite, who: string) =>
  (site.fake.data.drive as Record<string, FakeDrive>)[who]!

async function withDrive() {
  const site = await bootGoogle({ routes: [fakeDrive] })
  const owner = await site.person('ada@cms.test', 'editor')
  await site.connect(owner, 'ada', { service: 'drive' })
  const [account] = await listAccounts(site.cms(), owner.user.id)
  return { site, owner, account: account!.id }
}

const open = (site: GoogleSite, who: Person, body: Record<string, unknown>) =>
  site.request('POST', '/api/p/google/drive/uploads', { json: body, cookie: who.cookie })

const file = { name: 'brief.pdf', bytes: 600, type: 'application/pdf' }

describe('uploading to Drive', () => {
  it('shows the form for the folder, with the uploader', async () => {
    const { site, owner, account } = await withDrive()
    const page = await site.screen('/admin/google/drive/upload', owner.user, { folder: 'acme' })
    expect(page.title).toBe('Upload to Drive')
    expect(page.html).toContain('data-open="/api/p/google/drive/uploads"')
    expect(page.html).toContain(`name="account" value="${account}"`)
    expect(page.html).toContain('name="folder" value="acme"')
    expect(page.html).toContain('<script src="/api/p/google/upload.js" async=""></script>')
    // A file isn't a folder to upload into, and the list screen links here.
    expect(
      (await site.screen('/admin/google/drive/upload', owner.user, { folder: 'notes' })).kind,
    ).toBe('not-found')
    const list = await site.kernel.resolveAdminPage(
      '/admin/google/drive',
      { folder: 'acme' },
      owner.user,
    )
    expect(list.kind === 'page' && list.titleAction).toEqual({
      label: 'Upload',
      url: `/admin/google/drive/upload?account=${account}&folder=acme`,
    })
  })

  it('opens an upload into the folder and hands the browser its address, never a token', async () => {
    const { site, owner, account } = await withDrive()
    const response = await open(site, owner, { ...file, account, folder: 'acme' })
    expect(response.status).toBe(200)
    const { url } = (await response.json()) as { url: string }
    expect(
      url.startsWith(
        `${site.fake.url}/www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=`,
      ),
    ).toBe(true)
    expect(url).not.toMatch(/ya29|refresh/)

    // The browser's part: two pieces, with no token.
    const bytes = Uint8Array.from({ length: file.bytes }, (_, index) => index % 251)
    const firstPiece = await fetch(url, {
      method: 'PUT',
      headers: { 'content-range': `bytes 0-255/${file.bytes}` },
      body: bytes.subarray(0, 256),
    })
    expect(firstPiece.status).toBe(308)
    expect(firstPiece.headers.get('range')).toBe('bytes=0-255')
    const last = await fetch(url, {
      method: 'PUT',
      headers: { 'content-range': `bytes 256-${file.bytes - 1}/${file.bytes}` },
      body: bytes.subarray(256),
    })
    expect(last.status).toBe(200)
    const made = Object.values(driveOf(site, 'ada').files).find(
      (entry) => entry.name === 'brief.pdf',
    )!
    expect(made).toMatchObject({ parents: ['acme'], mimeType: 'application/pdf' })
    expect(Buffer.from(made.content!, 'base64').equals(Buffer.from(bytes))).toBe(true)

    const done = await site.request('POST', '/api/p/google/drive/uploads/done', {
      json: { account, folder: 'acme', id: made.id },
      cookie: owner.cookie,
    })
    expect(await done.json()).toEqual({
      redirect: `/admin/google/drive?account=${account}&folder=acme&uploaded=1`,
    })
  })

  it('refuses what it can’t take, before asking Drive anything', async () => {
    const { site, owner, account } = await withDrive()
    const before = site.fake.requests.length
    const refused = async (body: Record<string, unknown>, status: number) => {
      const response = await open(site, owner, { ...file, account, folder: 'acme', ...body })
      expect({ body, status: response.status }).toEqual({ body, status })
    }
    await refused({ name: '' }, 400)
    await refused({ bytes: 0 }, 400)
    await refused({ bytes: '600' }, 400)
    await refused({ type: 'not a type' }, 400)
    await refused({ type: 'text/plain\r\nX-Injected: 1' }, 400)
    await refused({ folder: '../etc' }, 400)
    await refused({ account: 'someone-else' }, 404)
    const asText = await site.request('POST', '/api/p/google/drive/uploads', {
      body: JSON.stringify({ ...file, account }),
      headers: { 'content-type': 'text/plain' },
      cookie: owner.cookie,
    })
    expect(asText.status).toBe(415)
    expect(
      (await site.request('POST', '/api/p/google/drive/uploads', { json: { ...file, account } }))
        .status,
    ).toBe(403)
    const eve = await site.person('eve@cms.test', 'editor')
    expect((await open(site, eve, { ...file, account })).status).toBe(404)
    expect(
      site.fake.requests.slice(before).filter((request) => request.path.includes('/upload/')),
    ).toEqual([])
    // A file with no type the browser knows still goes up, as bytes.
    expect((await open(site, owner, { ...file, account, type: '' })).status).toBe(200)
    // A folder Drive doesn't have is its to refuse.
    expect((await open(site, owner, { ...file, account, folder: 'no-such-folder' })).status).toBe(
      404,
    )
  })
})
