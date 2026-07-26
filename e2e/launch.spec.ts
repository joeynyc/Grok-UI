import { expect, test } from '@playwright/test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const fixtureRoot = path.join(os.tmpdir(), 'grok-ui-e2e')
const grokHome = path.join(fixtureRoot, 'grok-home')
const workspace = path.join(fixtureRoot, 'secret-client')
const sessionId = 'live-e2e-session'

async function registerLiveSession() {
  const sessionDirectory = path.join(grokHome, 'sessions', 'e2e-workspace', sessionId)
  const timestamp = new Date().toISOString()
  await fs.mkdir(sessionDirectory, { recursive: true })
  await Promise.all([
    fs.writeFile(path.join(sessionDirectory, 'summary.json'), JSON.stringify({
      info: { id: sessionId, cwd: workspace },
      generated_title: 'Confidential Launch',
      session_summary: 'Internal launch work for Example Person at 192.168.1.42',
      created_at: timestamp,
      updated_at: timestamp,
      num_messages: 2,
      num_chat_messages: 2,
      current_model_id: 'grok-e2e',
    })),
    fs.writeFile(path.join(sessionDirectory, 'signals.json'), JSON.stringify({
      turnCount: 1,
      toolCallCount: 1,
      contextWindowUsage: 25,
      modelsUsed: ['grok-e2e'],
    })),
    fs.writeFile(path.join(sessionDirectory, 'events.jsonl'), [
      JSON.stringify({ type: 'turn_started', ts: timestamp }),
      JSON.stringify({ type: 'phase_changed', phase: 'tool_execution', ts: timestamp }),
    ].join('\n') + '\n'),
    fs.writeFile(path.join(sessionDirectory, 'updates.jsonl'), [
      JSON.stringify({
        timestamp,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Connect to 192.168.1.42 as Example Person' },
        },
      }),
      JSON.stringify({
        timestamp,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'live-tool',
          title: 'Inspect secret-client',
          status: 'in_progress',
        },
      }),
    ].join('\n') + '\n'),
  ])
  await fs.writeFile(path.join(grokHome, 'active_sessions.json'), JSON.stringify([{
    session_id: sessionId,
    pid: process.pid,
    cwd: workspace,
    opened_at: timestamp,
  }]))
}

test.describe.serial('public launch path', () => {
  test('defaults a fresh browser to the Event Horizon theme', async ({ page }) => {
    await page.goto('/')

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'event-horizon')
    expect(await page.evaluate(() => localStorage.getItem('grok-ui-theme'))).toBe('event-horizon')
  })

  test('guides a clean installation through missing CLI and ready states', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: /Zero to live/ })).toBeVisible()
    await expect(page.getByText('FIRST CONTACT / SETUP REQUIRED')).toBeVisible()
    await expect(page.getByText('Grok CLI is missing or cannot run.')).toBeVisible()

    await fs.writeFile(path.join(grokHome, 'e2e-cli-ready'), 'unauthenticated\n')
    await page.getByRole('button', { name: /Recheck setup/ }).click()

    await expect(page.getByText('FIRST CONTACT / SETUP REQUIRED')).toBeVisible()
    await expect(page.getByText('Grok Build e2e')).toBeVisible()
    await expect(page.getByText('Authentication is required.')).toBeVisible()

    await fs.writeFile(path.join(grokHome, 'e2e-cli-ready'), 'ready\n')
    await page.getByRole('button', { name: /Recheck setup/ }).click()

    await expect(page.getByText('FIRST CONTACT / READY')).toBeVisible()
    await expect(page.getByText('Environment ready.')).toBeVisible()
  })

  test('discovers a newly registered Grok CLI session over the live stream', async ({ page }) => {
    await page.goto('/')
    await registerLiveSession()

    await expect(page.getByText('Confidential Launch').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('1', { exact: true }).first()).toBeVisible()
    await expect(page.getByText(/Inspect secret-client/).first()).toBeVisible()
    await expect(page.getByText(/PID \d+/).first()).toBeVisible()
  })

  test('redacts sensitive runtime data and persists Privacy Mode', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('Confidential Launch').first()).toBeVisible()
    await expect(page.getByText(/192\.168\.1\.42/)).toBeVisible()

    await page.getByRole('button', { name: 'Privacy' }).click()
    await expect(page.getByRole('button', { name: 'Privacy on' })).toHaveAttribute('aria-pressed', 'true')

    const body = await page.locator('body').innerText()
    expect(body).not.toContain('Confidential Launch')
    expect(body).not.toContain('secret-client')
    expect(body).not.toContain('Example Person')
    expect(body).not.toContain('192.168.1.42')
    expect(body).not.toContain(String(process.pid))

    await page.reload()
    await expect(page.getByRole('button', { name: 'Privacy on' })).toHaveAttribute('aria-pressed', 'true')
    expect(await page.locator('body').innerText()).not.toContain('secret-client')
  })

  test('launches and approves a managed ACP control session', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Control/ }).click()

    await expect(page.getByText('ACP CONTROL LINKED')).toBeVisible({ timeout: 10_000 })
    await page.getByLabel('WORKSPACE').fill(workspace)
    await page.getByLabel('INSTRUCTION').fill('Run the public release verification')
    await page.getByRole('button', { name: 'LAUNCH AGENT' }).click()

    await expect(page.getByText('New Grok lane launched.')).toBeVisible()
    await expect(page.getByText('Write the verified fixture')).toBeVisible()
    await page.getByRole('button', { name: 'Allow once' }).click()
    await expect(page.getByText('Permission approved and command completed.')).toBeVisible()
    await expect(page.getByText('20')).toBeVisible()
  })

  test('surfaces workflow telemetry and recovers a failed run across sessions', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Control/ }).click()

    await expect(page.getByText('ACP CONTROL LINKED')).toBeVisible({ timeout: 10_000 })
    await page.getByLabel('WORKSPACE').fill(workspace)
    await page.getByLabel('INSTRUCTION').fill('Start workflow fixture')
    await page.getByRole('button', { name: 'LAUNCH AGENT' }).click()

    await page.getByRole('button', { name: /Runs/ }).click()
    await expect(page.getByRole('heading', { name: /Every run/ })).toBeVisible()
    await expect(page.getByText('release-check').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('Recovery point available')).toBeVisible()
    await expect(page.getByText('Verify release')).toBeVisible()
    await expect(page.getByText('Verifier').first()).toBeVisible()
    await expect(page.getByText('4 / 8')).toBeVisible()
    await expect(page.getByText('grok-code-fast-1').first()).toBeVisible()
    await expect(page.locator('.workflow-token-total').getByText('6.4K')).toBeVisible()
    await expect(page.getByTitle('4,200 tokens')).toBeVisible()

    await page.getByRole('button', { name: 'Resume run' }).click()
    await expect(page.getByText('Release verified and ready to ship.')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.workflow-mission-head').getByText('completed')).toBeVisible()
    await expect(page.locator('.workflow-token-total').getByText('9.1K')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeDisabled()

    const snapshot = await (await page.request.get('/api/control')).json()
    expect(snapshot.workflows).toHaveLength(1)
    expect(snapshot.workflows[0]).toMatchObject({
      displayName: 'release-check',
      status: 'completed',
      agentsUsed: 5,
      totalTokens: 9_100,
      tokenTelemetryAvailable: true,
      elapsedMs: 78_000,
      resultSummary: 'Release verified and ready to ship.',
    })

    await page.getByRole('button', { name: 'Privacy' }).click()
    const privateBody = await page.locator('body').innerText()
    expect(privateBody).not.toContain('release-check')
    expect(privateBody).not.toContain('Ship a verified release')
    expect(privateBody).not.toContain('Release verified and ready to ship.')
  })

  test('pages and searches a large workflow agent roster', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Control/ }).click()

    await expect(page.getByText('ACP CONTROL LINKED')).toBeVisible({ timeout: 10_000 })
    await page.getByLabel('WORKSPACE').fill(workspace)
    await page.getByLabel('INSTRUCTION').fill('Start scaled workflow fixture')
    await page.getByRole('button', { name: 'LAUNCH AGENT' }).click()

    await page.getByRole('button', { name: /Runs/ }).click()
    await expect(page.getByText('scale-check').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('1–12 / 30')).toBeVisible()
    await expect(page.getByText('Scale agent 12')).toBeVisible()
    await expect(page.getByText('Scale agent 13')).toHaveCount(0)

    await page.getByRole('button', { name: 'Next agent page' }).click()
    await expect(page.getByText('13–24 / 30')).toBeVisible()
    await expect(page.getByText('Scale agent 13')).toBeVisible()

    await page.getByLabel('Search agent roster').fill('Scale agent 30')
    await expect(page.getByText('1–1 / 1')).toBeVisible()
    await expect(page.getByText('Scale agent 30')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Next agent page' })).toHaveCount(0)
  })

  test('cancels cleanly while a permission decision is pending', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Control/ }).click()

    await expect(page.getByText('ACP CONTROL LINKED')).toBeVisible({ timeout: 10_000 })
    await page.getByLabel('WORKSPACE').fill(workspace)
    await page.getByLabel('INSTRUCTION').fill('Hold for permission cancellation')
    await page.getByRole('button', { name: 'LAUNCH AGENT' }).click()

    const lane = page.locator('.lane-card').filter({ hasText: 'Hold for permission cancellation' })
    await expect(lane.locator('.lane-state')).toContainText('attention')
    await lane.getByRole('button', { name: 'Stop', exact: true }).click()

    await expect(lane.locator('.lane-state')).toContainText('cancelled')
    await expect(lane.getByText('CANCELLED BY USER')).toBeVisible()
    await lane.getByRole('button', { name: 'Open stream' }).click()
    await expect(page.getByText('Cancellation confirmed while permission was pending.')).toBeVisible()
    await expect(page.locator('.approval-card')).toHaveCount(0)
    await expect(lane.getByRole('button', { name: 'Resume' })).toBeVisible()
  })

  test('cancels an active tool and records a confirmed post-stop result', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Control/ }).click()

    await expect(page.getByText('ACP CONTROL LINKED')).toBeVisible({ timeout: 10_000 })
    await page.getByLabel('WORKSPACE').fill(workspace)
    await page.getByLabel('INSTRUCTION').fill('Run the long-running cancellation verification')
    await page.getByRole('button', { name: 'LAUNCH AGENT' }).click()

    const lane = page.locator('.lane-card').filter({ hasText: 'Run the long-running cancellation verification' })
    await expect(lane.locator('.lane-state')).toContainText('working')
    await lane.getByRole('button', { name: 'Open stream' }).click()
    await expect(page.getByText('Long-running cancellation fixture')).toBeVisible()
    await lane.getByRole('button', { name: 'Stop', exact: true }).click()

    await expect(lane.locator('.lane-state')).toContainText('cancelled')
    await expect(lane.getByText('CANCELLED BY USER')).toBeVisible()
    await expect(lane.getByText('Grok confirmed the turn stopped.')).toBeVisible()
    await expect(lane.getByText('No tool completed')).toBeVisible()
    await expect(page.getByText('Cancellation confirmed. No further tool work executed.')).toBeVisible()

    const snapshot = await (await page.request.get('/api/control')).json()
    const session = snapshot.sessions.find((item: { title: string }) =>
      item.title === 'Run the long-running cancellation verification')
    expect(session.cancellationStatus).toBe('confirmed')
    expect(session.stopReason).toBe('cancelled')
    expect(session.cancelRequestedAt).toBeTruthy()
    expect(session.cancelledAt).toBeTruthy()
    expect(session.feed.filter((item: { type: string; status: string }) =>
      item.type === 'tool' && item.status === 'completed')).toHaveLength(0)
    expect(session.feed.filter((item: { type: string }) => item.type === 'tool').at(-1).status).toBe('cancelled')
  })

  test('keeps the dashboard within a mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible()
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)
  })
})
