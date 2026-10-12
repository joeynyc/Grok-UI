import { expect, test, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const fixtureRoot = path.join(os.tmpdir(), 'grok-ui-e2e')
const workspace = path.join(fixtureRoot, 'secret-client')

async function recordSession(page: Page, id: string) {
  const directory = path.join(fixtureRoot, 'grok-home', 'sessions', 'review-workspace', id)
  const timestamp = new Date().toISOString()
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, 'summary.json'), JSON.stringify({
    info: { id, cwd: workspace },
    generated_title: 'Review fixture',
    created_at: timestamp,
    updated_at: timestamp,
    current_model_id: 'grok-e2e',
  }))
  await page.request.get('/api/dashboard?refresh=1')
}

test('refreshes Usage from the global refresh action and live session updates', async ({ page }) => {
  let tokens = 100
  let reportRequests = 0
  await page.route('**/api/usage?*', async (route) => {
    const response = await route.fetch()
    const report = await response.json()
    reportRequests += 1
    await route.fulfill({ json: {
      ...report,
      totals: { ...report.totals, totalTokens: { value: tokens, source: 'grok-reported' } },
    } })
  })
  await page.goto('/#/usage')
  await expect(page.locator('.usage-total > strong')).toHaveText('100')
  tokens = 200
  await page.getByRole('button', { name: 'Refresh data', exact: true }).click()
  await expect(page.locator('.usage-total > strong')).toHaveText('200')
  expect(reportRequests).toBeGreaterThan(1)

  tokens = 300
  const started = await page.request.post('/api/control/sessions', {
    data: { cwd: workspace, prompt: 'Verify recovered control session' },
  })
  expect(started.ok()).toBe(true)
  await expect(page.locator('.usage-total > strong')).toHaveText('300', { timeout: 10_000 })
  await expect(page.locator('.usage-updated time')).toHaveAttribute('datetime', /\d{4}-/)
})

test('keeps the selected file and patch together when diff requests finish out of order', async ({ page }) => {
  await recordSession(page, 'review-diff-session')
  await page.route('**/api/workspace?*', async (route) => {
    const cwd = new URL(route.request().url()).searchParams.get('cwd')
    await route.fulfill({ json: {
      cwd, root: cwd, repository: true, branch: 'review-fixture', upstream: '',
      ahead: 0, behind: 0, dirty: true, additions: 2, deletions: 0, error: '',
      files: ['a.ts', 'b.ts'].map((file) => ({ path: file, status: ' M', staged: false, additions: 1, deletions: 0 })),
    } })
  })
  let releaseFirst!: () => void
  const firstResponse = new Promise<void>((resolve) => { releaseFirst = resolve })
  let firstRequested!: () => void
  const firstRequest = new Promise<void>((resolve) => { firstRequested = resolve })
  let firstSettled!: () => void
  const firstComplete = new Promise<void>((resolve) => { firstSettled = resolve })
  await page.route('**/api/workspace/diff?*', async (route) => {
    const url = new URL(route.request().url())
    const file = url.searchParams.get('file')
    if (file === 'a.ts') {
      firstRequested()
      await firstResponse
    }
    try {
      await route.fulfill({ json: { cwd: workspace, path: file, diff: `PATCH_${file}`, truncated: false } })
    } finally {
      if (file === 'a.ts') firstSettled()
    }
  })
  await page.goto('/#/changes')
  await page.locator('.change-file-list button').filter({ hasText: 'a.ts' }).click()
  await firstRequest
  await page.locator('.change-file-list button').filter({ hasText: 'b.ts' }).click()
  await expect(page.locator('.diff-viewer pre')).toHaveText('PATCH_b.ts')
  releaseFirst()
  // Flush the delayed response and rendering, including when it was cancelled.
  await firstComplete
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect(page.locator('.diff-viewer h2')).toHaveText('b.ts')
  await expect(page.locator('.diff-viewer pre')).toHaveText('PATCH_b.ts')
})

test('preserves an unfinished session rename during a background refresh', async ({ page }) => {
  const created = await page.request.post('/api/control/sessions', {
    data: { cwd: workspace, prompt: 'Verify recovered control session' },
  })
  expect(created.ok()).toBe(true)
  const session = await created.json()
  await page.goto(`/#/live/${session.id}`)
  await page.getByRole('button', { name: 'Rename session', exact: true }).click()
  await page.getByRole('textbox', { name: 'Session title' }).fill('My unfinished new title')
  const refreshed = page.waitForResponse((response) => response.url().endsWith(`/api/sessions/${session.id}/workbench`))
  const followUp = await page.request.post(`/api/control/sessions/${session.id}/prompt`, {
    data: { cwd: workspace, prompt: 'Verify recovered control session' },
  })
  expect(followUp.ok()).toBe(true)
  await refreshed
  await expect(page.getByRole('textbox', { name: 'Session title' })).toHaveValue('My unfinished new title')
})

test('keeps the reading position until Latest is chosen', async ({ page }) => {
  const created = await page.request.post('/api/control/sessions', {
    data: { cwd: workspace, prompt: 'Verify recovered control session' },
  })
  expect(created.ok()).toBe(true)
  const session = await created.json()
  let eventCount = 30
  await page.route(`**/api/sessions/${session.id}/workbench`, async (route) => {
    const response = await route.fetch()
    const snapshot = await response.json()
    await route.fulfill({ json: { ...snapshot, transcript: Array.from({ length: eventCount }, (_, index) => ({
      id: `reading-${index}`, sessionId: session.id, type: 'assistant', title: `Step ${index}`,
      text: `Result ${index}. Enough content to give this recorded timeline a realistic reading height.`,
      timestamp: new Date().toISOString(),
    })) } })
  })
  await page.goto(`/#/live/${session.id}`)
  const timeline = page.locator('.workbench-timeline')
  await expect(timeline.locator('.workbench-event')).toHaveCount(30)
  await expect.poll(() => timeline.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(48)
  await timeline.hover()
  await page.mouse.wheel(0, -800)
  await expect(page.getByRole('button', { name: 'Latest', exact: true })).toBeVisible()
  const readingTop = await timeline.evaluate((element) => element.scrollTop)
  eventCount = 31
  const followUp = await page.request.post(`/api/control/sessions/${session.id}/prompt`, {
    data: { cwd: workspace, prompt: 'Verify recovered control session' },
  })
  expect(followUp.ok()).toBe(true)
  await expect(timeline.locator('.workbench-event')).toHaveCount(31)
  await expect.poll(async () => Math.abs(await timeline.evaluate((element) => element.scrollTop) - readingTop)).toBeLessThan(5)
  await page.getByRole('button', { name: 'Latest', exact: true }).click()
  await expect.poll(() => timeline.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(48)
})
