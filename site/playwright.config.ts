import { defineConfig, devices } from '@playwright/test'

const PORT = 3510
/** The stand-in for Google's servers (e2e/fake-google.mjs), where the site sends its requests. */
const GOOGLE_PORT = 3511

export default defineConfig({
  testDir: './e2e',
  // One server on one embedded database, set up by the first test.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node e2e/fake-google.mjs',
      url: `http://127.0.0.1:${GOOGLE_PORT}/__/health`,
      reuseExistingServer: false,
      env: { FAKE_GOOGLE_PORT: String(GOOGLE_PORT) },
    },
    {
      // A fresh database and mail folder each run, so the first visit sets the site up.
      command: `node -e "for (const dir of ['.data/e2e', '.data/e2e-mail']) fs.rmSync(dir, { recursive: true, force: true })" && pnpm build && pnpm start --port ${PORT}`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      env: {
        CMS_DATA_DIR: '.data/e2e',
        DATABASE_URL: '',
        MAIL_FILE_DIR: '.data/e2e-mail',
        // Google is the stand-in; the client's id and secret are the ones it knows.
        GOOGLE_API_URL: `http://127.0.0.1:${GOOGLE_PORT}`,
        GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
        GOOGLE_CLIENT_SECRET: 'test-client-secret',
      },
    },
  ],
})
