import { defineConfig, devices } from '@playwright/test'

const browser = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? 'webkit' : 'chromium'
const browserDevice = browser === 'webkit' ? 'Desktop Safari' : 'Desktop Chrome'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  expect: {
    timeout: browser === 'webkit' ? 15_000 : 5_000,
  },
  reporter: process.env.CI
    ? [['line'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4399',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: browser,
      use: { ...devices[browserDevice] },
    },
  ],
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: 'http://127.0.0.1:4399/api/health',
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
