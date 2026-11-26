import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// The plugin's promise to a site: installed and active, it loads nothing but its small
// definition until someone uses a Google screen or route. These tests hold it to that.

const loaded = vi.hoisted(() => new Set<string>())
const track = vi.hoisted(() => (name: string) => async (original: () => Promise<unknown>) => {
  loaded.add(name)
  return original()
})

vi.mock('../src/accounts', track('accounts'))
vi.mock('../src/actions', track('actions'))
vi.mock('../src/google', track('google'))
vi.mock('../src/mail', track('mail'))
vi.mock('../src/mime', track('mime'))
vi.mock('../src/oauth', track('oauth'))
vi.mock('../src/runtime', track('runtime'))
vi.mock('../src/schema', track('schema'))
vi.mock('../src/secrets', track('secrets'))
vi.mock('../src/sign-in', track('sign-in'))
vi.mock('../src/screens/accounts', track('screens/accounts'))
vi.mock('../src/screens/parts', track('screens/parts'))
vi.mock('../src/services/shared', track('services/shared'))
vi.mock('../src/screens/no-account', track('screens/no-account'))

// The folder has a space in its path, which a URL's pathname keeps encoded.
const SRC = fileURLToPath(new URL('../src/', import.meta.url))

/** What a file imports for real: `import type` and `export type` lines cost nothing at run time. */
function imports(file: string): string[] {
  const source = readFileSync(join(SRC, file), 'utf8')
  return [...source.matchAll(/^import (?!type\b)[^'"]*?['"]([^'"]+)['"]/gms)].map(
    (match) => match[1]!,
  )
}

describe('what the site loads', () => {
  it('is the definition and nothing behind it, until a Google screen or route is used', async () => {
    const { bootGoogle } = await import('./fixtures')
    const site = await bootGoogle({ settings: { 'google.site_mail': true } })
    const ada = await site.person('ada@cms.test')
    expect([...loaded]).toEqual([])

    // A site page, the sign-in pages' buttons, the admin's menu and another plugin's screen.
    await site.kernel.resolvePage('/nothing-here')
    expect(site.kernel.signInProviders('admin', '/admin')).toHaveLength(1)
    expect(site.kernel.adminMenu(ada.user).some((section) => section.id === 'google')).toBe(true)
    await site.kernel.resolveAdminPage('/admin/plugins', {}, ada.user)
    await site.get('/api/p/core/cron')
    expect([...loaded]).toEqual([])

    // The accounts screen brings what it needs, and not the way to Google or the mailer.
    await site.screen('/admin/google', ada.user)
    expect([...loaded].sort()).toEqual([
      'accounts',
      'google',
      'runtime',
      'schema',
      'screens/accounts',
      'screens/parts',
      'secrets',
    ])

    // Leaving for Google brings the connect flow.
    await site.leave(ada)
    expect(loaded).toContain('oauth')
    expect(loaded.has('mail')).toBe(false)
    expect(loaded.has('sign-in')).toBe(false)

    // The first email brings the mailer.
    await site.kernel.mail.send({ to: 'x@example.com', subject: 'S', text: 'T' })
    expect(loaded).toContain('mail')
  })
})

describe('the files every request loads', () => {
  // Nothing here may be imported for real by the main entry or the admin entry, directly or
  // through the files they import: only names, settings and each service's list of routes.
  const LIGHT = new Set(['./config', './settings', './migrations', './index'])
  const OUTSIDE = new Set(['@otwdesign/sdk', 'drizzle-orm'])

  const services = readdirSync(join(SRC, 'services'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  it('the main entry imports only the light files and each service’s routes', () => {
    const allowed = new Set([
      ...LIGHT,
      ...OUTSIDE,
      ...services.map((id) => `./services/${id}/routes`),
    ])
    expect(imports('index.tsx').filter((name) => !allowed.has(name))).toEqual([])
    for (const file of ['config.ts', 'settings.ts', 'migrations.ts']) {
      expect({
        file,
        heavy: imports(file).filter((name) => !LIGHT.has(name) && !OUTSIDE.has(name)),
      }).toEqual({ file, heavy: [] })
    }
  })

  it('the admin entry imports only the light files and each service’s screens list', () => {
    const allowed = new Set([
      ...LIGHT,
      ...OUTSIDE,
      ...services.map((id) => `./services/${id}/admin`),
      './screens/tabbed',
    ])
    expect(imports('admin.tsx').filter((name) => !allowed.has(name))).toEqual([])
    // It puts the tabs above a screen, and imports them with the screen.
    expect(imports('screens/tabbed.ts').filter((name) => !OUTSIDE.has(name))).toEqual([])
  })

  it('a service’s routes and screens lists import nothing but names', () => {
    expect(services.sort()).toEqual(['drive', 'gmail', 'youtube'])
    const allowed = new Set([...OUTSIDE, '../../config', '../../screens/tabbed'])
    for (const id of services) {
      // A screens list may be written with JSX.
      const admin = existsSync(join(SRC, `services/${id}/admin.tsx`)) ? 'admin.tsx' : 'admin.ts'
      for (const file of ['routes.ts', admin]) {
        const heavy = imports(`services/${id}/${file}`).filter((name) => !allowed.has(name))
        expect({ file: `${id}/${file}`, heavy }).toEqual({ file: `${id}/${file}`, heavy: [] })
      }
    }
  })

  /**
   * Every file the main entry can reach, by an import or by `import()`: Next.js sends a page the
   * browser code of whatever its server files can reach, used or not, and the site's pages
   * import the main entry. So nothing here may import a component.
   */
  function reachable(entry: string): Map<string, string[]> {
    const seen = new Map<string, string[]>()
    const queue = [entry]
    while (queue.length > 0) {
      const file = queue.pop()!
      if (seen.has(file)) continue
      const source = readFileSync(join(SRC, file), 'utf8')
        // A type-only import or export is erased: it loads nothing.
        .replace(/^(?:import|export) type\b[^;]*?from\s+['"][^'"]+['"]/gms, '')
      const names = [
        ...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|^import\s+)['"]([^'"]+)['"]/gm),
      ].map((match) => match[1]!)
      seen.set(
        file,
        names.filter((name) => !name.startsWith('.')),
      )
      for (const name of names.filter((item) => item.startsWith('.'))) {
        const base = join(dirname(file), name)
        const found = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((candidate) =>
          existsSync(join(SRC, candidate)),
        )
        if (!found) throw new Error(`${file} imports ${name}, which isn't a file`)
        queue.push(found)
      }
    }
    return seen
  }

  it('nothing the main entry can reach, by import or by import(), is a component or imports one', () => {
    const graph = reachable('index.tsx')
    // The entry itself, its light files, and the code behind the routes: all reached, none JSX.
    expect([...graph.keys()]).toEqual(
      expect.arrayContaining(['oauth.ts', 'accounts.ts', 'mail.ts']),
    )
    expect([...graph.keys()].filter((file) => file.endsWith('.tsx'))).toEqual(['index.tsx'])
    const outside = new Set([...graph.values()].flat())
    for (const name of outside) {
      expect(
        name.startsWith('node:') ||
          ['@otwdesign/sdk', 'drizzle-orm', 'drizzle-orm/pg-core'].includes(name),
        `the main entry reaches ${name}`,
      ).toBe(true)
    }
  })

  it('no file under src is a client component', () => {
    const files = (dir: string): string[] =>
      readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
      )
    const client = files('').filter((file) =>
      /^\s*['"]use client['"]/m.test(readFileSync(join(SRC, file), 'utf8')),
    )
    expect(client).toEqual([])
  })
})
