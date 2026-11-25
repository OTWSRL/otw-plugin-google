import { expect, test, type Page } from '@playwright/test'

// One site, set up by the first test; the rest build on it, in order. Google is a stand-in
// (e2e/fake-google.mjs): its consent screen asks who you are and what you allow.
test.describe.configure({ mode: 'serial' })

const ADMIN = { name: 'Ada Admin', email: 'ada@gmail.com', password: 'a strong e2e password' }
const GOOGLE = 'http://127.0.0.1:3511'

let admin: Page

const notice = (page: Page, message: string | RegExp) =>
  expect(page.getByRole('status').filter({ hasText: message })).toBeVisible()
const error = (page: Page, message: string | RegExp) =>
  expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible()

/** The stand-in's consent screen: chooses an account and allows, or cancels. */
async function consent(page: Page, email: string, answer: 'Allow' | 'Cancel' = 'Allow') {
  await expect(page.getByRole('heading', { name: 'Google (stand-in)' })).toBeVisible()
  if (answer === 'Allow') await page.getByLabel(email).check()
  await page.getByRole('button', { name: answer }).click()
}

/** The admin table row whose first cell holds `text`. */
const row = (page: Page, text: string | RegExp) =>
  page.locator('tbody tr').filter({ hasText: text })

/** Every request a page makes while `run` runs, as addresses. */
async function requestsDuring(page: Page, run: () => Promise<unknown>): Promise<string[]> {
  const urls: string[] = []
  const listen = (request: { url(): string }) => urls.push(request.url())
  page.on('request', listen)
  await run()
  await page.waitForLoadState('networkidle')
  page.off('request', listen)
  return urls
}

test.beforeAll(async ({ browser }) => {
  admin = await browser.newPage()
})

test('the first visit sets the site up, and Google has a menu of its own', async () => {
  await admin.goto('/admin')
  await expect(admin).toHaveURL('/admin/setup')
  await admin.getByLabel('Name').fill(ADMIN.name)
  await admin.getByLabel('Email').fill(ADMIN.email)
  await admin.getByLabel('Password').fill(ADMIN.password)
  await admin.getByRole('button', { name: 'Create administrator' }).click()
  await notice(admin, 'Your site is ready.')

  await admin.goto('/admin/google')
  await expect(admin.getByRole('heading', { name: 'Google accounts', level: 1 })).toBeVisible()
  await expect(admin.getByText('You haven’t connected a Google account yet.')).toBeVisible()
  // The setup box names the two addresses to give Google.
  await expect(admin.getByText('/api/p/google/oauth/callback')).toBeVisible()
  await expect(admin.getByText('/api/p/core/sign-in/google/callback')).toBeVisible()
  const menu = admin.getByRole('navigation', { name: 'Main menu' })
  for (const name of ['Accounts', 'YouTube', 'Drive', 'Settings']) {
    await expect(menu.getByRole('link', { name, exact: true }).first()).toBeAttached()
  }
})

test('a page of the site, and another admin screen, load nothing of the plugin', async ({
  browser,
}) => {
  const visitor = await (await browser.newContext()).newPage()
  const site = await requestsDuring(visitor, () => visitor.goto('/'))
  expect(site.filter((url) => /google|upload\.js/i.test(url))).toEqual([])
  expect(await visitor.content()).not.toMatch(/google/i)

  const dashboard = await requestsDuring(admin, () => admin.goto('/admin/plugins'))
  expect(dashboard.filter((url) => url.includes('/api/p/google') || url.includes(GOOGLE))).toEqual(
    [],
  )
  // The menu entry is the plugin's only trace on another admin screen.
  const html = await admin.content()
  expect(html).not.toContain('otw-google')
  expect(html).not.toContain('upload.js')
})

test('the administrator connects a Google account, then allows YouTube for it', async () => {
  await admin.goto('/admin/google')
  await admin.getByRole('link', { name: 'Connect an account' }).first().click()
  await expect(admin).toHaveURL(new RegExp(`^${GOOGLE}/accounts\\.google\\.com/o/oauth2/v2/auth`))
  // The account alone at first: who they are, nothing more.
  await expect(admin.getByLabel('openid')).toBeChecked()
  await expect(admin.getByText('auth/youtube')).toHaveCount(0)
  await consent(admin, 'ada@gmail.com')
  await expect(admin).toHaveURL('/admin/google?google=connected')
  await notice(admin, 'The Google account is connected.')
  const account = row(admin, 'ada@gmail.com')
  await expect(account).toContainText('Ada Lovelace')
  await expect(account).toContainText('the account you sign in with')
  await expect(account).toContainText('Nothing yet')
  await expect(account).toContainText('Connected')

  await account.getByRole('link', { name: 'Allow YouTube' }).click()
  await expect(admin.getByText('https://www.googleapis.com/auth/youtube')).toBeVisible()
  await consent(admin, 'ada@gmail.com')
  await notice(admin, 'The Google account is connected.')
  await expect(row(admin, 'ada@gmail.com')).toContainText('YouTube')
  await expect(
    row(admin, 'ada@gmail.com').getByRole('link', { name: 'Allow YouTube' }),
  ).toHaveCount(0)
})

test('cancelling at Google changes nothing, and says so', async () => {
  await row(admin, 'ada@gmail.com').getByRole('link', { name: 'Allow Drive' }).click()
  await consent(admin, 'ada@gmail.com', 'Cancel')
  await expect(admin).toHaveURL('/admin/google?google=denied')
  await error(admin, 'You didn’t allow it at Google, so nothing changed.')
  await expect(row(admin, 'ada@gmail.com').getByRole('link', { name: 'Allow Drive' })).toBeVisible()
})

test('YouTube lists the channel’s videos and saves a change to one', async () => {
  await admin.goto('/admin/google/youtube')
  await expect(admin.getByRole('heading', { name: 'YouTube', level: 1 })).toBeVisible()
  await expect(admin.getByText('Ada Builds')).toBeVisible()
  await expect(row(admin, 'Building a CMS in a weekend')).toContainText('Public')
  await expect(admin.locator('tbody tr')).toHaveCount(25)

  await row(admin, 'Building a CMS in a weekend')
    .getByRole('link', { name: 'Building a CMS in a weekend' })
    .click()
  await expect(
    admin.getByRole('heading', { name: 'Edit “Building a CMS in a weekend”' }),
  ).toBeVisible()
  await admin.getByLabel('Title').fill('Building a CMS in a weekend, part one')
  await admin.getByLabel('Visibility').selectOption('unlisted')
  await admin.getByRole('button', { name: 'Update' }).click()
  await notice(admin, 'Video updated.')
  await expect(admin.getByLabel('Title')).toHaveValue('Building a CMS in a weekend, part one')
  await expect(admin.getByLabel('Visibility')).toHaveValue('unlisted')
})

test('a video goes from the browser straight to YouTube, in pieces, and shows in the list', async () => {
  await admin.goto('/admin/google/youtube')
  await admin.getByRole('link', { name: 'Upload video' }).click()
  await expect(admin.getByRole('heading', { name: 'Upload video', level: 1 })).toBeVisible()

  // Nine megabytes: more than one piece.
  const bytes = Buffer.alloc(9 * 1024 * 1024, 7)
  await admin
    .getByLabel('The file')
    .setInputFiles({ name: 'episode-12.mp4', mimeType: 'video/mp4', buffer: bytes })
  await admin.getByLabel('Title').fill('Episode 12: the final cut')
  await admin.getByLabel('Description').fill('What changed since episode 11.')
  await admin.getByLabel('Playlist').selectOption({ label: 'Weekly episodes' })

  const toGoogle: {
    method: string
    url: string
    range: string | undefined
    auth: string | undefined
  }[] = []
  const toSite: string[] = []
  admin.on('request', (request) => {
    if (request.url().startsWith(GOOGLE)) {
      toGoogle.push({
        method: request.method(),
        url: request.url(),
        range: request.headers()['content-range'],
        auth: request.headers().authorization,
      })
    } else if (request.method() === 'POST') toSite.push(new URL(request.url()).pathname)
  })
  await admin.getByRole('button', { name: 'Upload' }).click()
  await expect(admin).toHaveURL(/\/admin\/google\/youtube\?account=[\w-]+&uploaded=1$/)
  await notice(admin, 'The video is at YouTube.')
  await expect(row(admin, 'Episode 12: the final cut')).toContainText('Private')

  // The file went to Google's address in two pieces, with no token; the site got two small posts.
  const pieces = toGoogle.filter((request) => request.method === 'PUT')
  expect(pieces.map((request) => request.range)).toEqual([
    `bytes 0-8388607/${bytes.length}`,
    `bytes 8388608-${bytes.length - 1}/${bytes.length}`,
  ])
  expect(pieces.every((request) => request.auth === undefined)).toBe(true)
  expect(
    pieces.every((request) =>
      request.url.includes('/upload/youtube/v3/videos?uploadType=resumable&upload_id='),
    ),
  ).toBe(true)
  expect(toSite).toEqual(['/api/p/google/youtube/uploads', '/api/p/google/youtube/uploads/done'])
})

test('Drive is allowed, browsed, and takes a file from the browser', async () => {
  await admin.goto('/admin/google/drive')
  await expect(admin.getByText('None of your Google accounts has allowed Drive yet.')).toBeVisible()
  await admin.getByRole('link', { name: 'Allow Drive for ada@gmail.com' }).click()
  await consent(admin, 'ada@gmail.com')
  // Back on the screen it was asked from.
  await expect(admin).toHaveURL(/\/admin\/google\/drive\?google=connected$/)
  await admin.getByRole('link', { name: 'Clients', exact: true }).click()
  await admin.getByRole('link', { name: 'Acme', exact: true }).click()
  await expect(row(admin, 'Episode 12, final cut.mp4')).toBeVisible()
  await expect(row(admin, 'Contract, signed.pdf')).toBeVisible()

  await admin.getByRole('link', { name: 'Upload', exact: true }).click()
  await expect(admin.getByRole('heading', { name: 'Upload to Drive', level: 1 })).toBeVisible()
  await admin.getByLabel('The file').setInputFiles({
    name: 'brief.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Call Grace on Thursday.'),
  })
  await admin.getByRole('button', { name: 'Upload' }).click()
  await expect(admin).toHaveURL(/\/admin\/google\/drive\?account=[\w-]+&folder=acme&uploaded=1$/)
  await expect(row(admin, 'brief.txt')).toBeVisible()

  // The file's bytes come back through the site, as a download.
  const download = admin.waitForEvent('download')
  // A row's actions show when the pointer is on the row, as in WordPress.
  await row(admin, 'brief.txt').hover()
  await row(admin, 'brief.txt').getByRole('link', { name: 'Download' }).click()
  const saved = await download
  expect(saved.suggestedFilename()).toBe('brief.txt')
})

test('someone new signs in with Google, gets an account, and sees the Google screens only', async ({
  browser,
}) => {
  const page = await (await browser.newContext()).newPage()
  await page.goto('/admin')
  await expect(page).toHaveURL(/\/admin\/login\?next=/)
  const button = page.getByRole('link', { name: 'Continue with Google' })
  await expect(button).toHaveAttribute(
    'href',
    '/api/p/core/sign-in/google?screen=admin&next=%2Fadmin',
  )
  await button.click()
  // Signing in asks for who they are, nothing else.
  await expect(page.getByLabel('openid')).toBeChecked()
  await expect(page.getByText('googleapis.com/auth')).toHaveCount(0)
  await consent(page, 'grace@example.com')
  await expect(page).toHaveURL('/admin')
  await expect(page.getByText('Howdy, Grace Hopper')).toBeVisible()
  const menu = page.getByRole('navigation', { name: 'Main menu' })
  await expect(menu.getByRole('link', { name: 'Google', exact: true })).toBeVisible()
  await expect(menu.getByRole('link', { name: 'Plugins' })).toHaveCount(0)
  // Their own profile is the only thing under Users, as for a WordPress subscriber.
  await expect(menu.locator('a[href^="/admin/users"]')).toHaveCount(0)
  await expect(menu.locator('a[href="/admin/profile"]').first()).toBeAttached()
  await expect(menu.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0)

  // Her own accounts only: the administrator's isn't hers to see.
  await page.goto('/admin/google')
  await expect(page.getByText('You haven’t connected a Google account yet.')).toBeVisible()
  await expect(page.getByText('ada@gmail.com')).toHaveCount(0)
  await expect(page.getByText('Redirect addresses')).toHaveCount(0)
  // And the settings aren't hers to open.
  await page.goto('/admin/google/settings')
  await expect(page.getByText('Sorry, you are not allowed to access this page.')).toBeVisible()
  await page.context().close()
})

test('the administrator signs in with Google too, as the account that has the address', async ({
  browser,
}) => {
  const page = await (await browser.newContext()).newPage()
  await page.goto('/admin/login')
  await page.getByRole('link', { name: 'Continue with Google' }).click()
  await consent(page, 'ada@gmail.com')
  await expect(page).toHaveURL('/admin')
  await expect(page.getByText(`Howdy, ${ADMIN.name}`)).toBeVisible()
  await page.context().close()
})

test('the settings switch a service off, and its screen and menu entry go', async () => {
  await admin.goto('/admin/google/settings')
  await expect(admin.getByRole('heading', { name: 'Google settings', level: 1 })).toBeVisible()
  await expect(admin.getByText('Set by the GOOGLE_CLIENT_ID environment variable')).toBeVisible()
  await admin.getByLabel('Drive', { exact: true }).uncheck()
  await admin.getByRole('button', { name: 'Save Changes' }).click()
  await notice(admin, /saved/i)
  await admin.goto('/admin/google')
  const menu = admin.getByRole('navigation', { name: 'Main menu' })
  await expect(menu.getByRole('link', { name: 'Drive', exact: true })).toHaveCount(0)
  const gone = await admin.goto('/admin/google/drive')
  expect(gone!.status()).toBe(404)
})

test('disconnecting takes the account away here and the grant away at Google', async () => {
  await admin.goto('/admin/google')
  await row(admin, 'ada@gmail.com').hover()
  await row(admin, 'ada@gmail.com').getByRole('button', { name: 'Disconnect' }).click()
  await notice(admin, 'ada@gmail.com is disconnected. This site no longer has access to it.')
  await expect(admin.getByText('You haven’t connected a Google account yet.')).toBeVisible()
})
