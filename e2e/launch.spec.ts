import { expect, test, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const fixtureRoot = path.join(os.tmpdir(), 'grok-ui-e2e')
const grokHome = path.join(fixtureRoot, 'grok-home')
const workspace = path.join(fixtureRoot, 'secret-client')
const sessionId = 'live-e2e-session'

async function unreadableVisibleText(page: Page, minimumPx = 8) {
  return page.locator('body *').evaluateAll((elements, minimum) => elements
    .filter((element) => {
      const hasDirectText = [...element.childNodes].some((node) =>
        node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()))
      if (!hasDirectText) return false
      const style = getComputedStyle(element)
      const bounds = element.getBoundingClientRect()
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity) > 0
        && bounds.width > 0
        && bounds.height > 0
        && Number.parseFloat(style.fontSize) < minimum
    })
    .map((element) => ({
      element: element.tagName.toLowerCase(),
      className: element.className,
      text: element.textContent?.trim().slice(0, 80),
      fontSize: getComputedStyle(element).fontSize,
    })), minimumPx)
}

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
      toolCallCount: 3,
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
      JSON.stringify({
        timestamp,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'runtime-test-tool',
          title: 'Run Vitest suite',
          status: 'completed',
        },
      }),
      JSON.stringify({
        timestamp,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'runtime-external-tool',
          title: 'Fetch GitHub issue',
          status: 'completed',
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

  test('reconnects the browser event stream after a server interruption', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Overview/ }).click()
    await expect(page.getByText('EVENT STREAM LINKED')).toBeVisible()

    const disconnected = await page.request.post('/api/test/disconnect-events')
    expect(disconnected.ok()).toBe(true)
    expect((await disconnected.json()).disconnected).toBeGreaterThan(0)
    await expect(page.getByText('EVENT STREAM RECONNECTING')).toBeVisible({ timeout: 10_000 })

    await expect(page.getByText('EVENT STREAM LINKED')).toBeVisible({ timeout: 15_000 })
  })

  test('shows bounded process, test, and external-call runtime intelligence', async ({ page }) => {
    await page.goto('/')

    const intelligence = page.locator('.runtime-intelligence')
    await expect(intelligence.getByRole('heading', { name: /What the agents started/ })).toBeVisible()
    await expect(intelligence.getByText('Spawned descendants')).toBeVisible()
    await expect(intelligence.getByText('Run Vitest suite')).toBeVisible()
    await expect(intelligence.getByText('Fetch GitHub issue')).toBeVisible()

    const runtime = await (await page.request.get('/api/runtime?refresh=1')).json()
    expect(runtime.roots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          managed: false,
          sessionIds: ['live-e2e-session'],
        }),
      ]),
    )
    expect(runtime.processes.length).toBeGreaterThan(0)
    expect(runtime.tests[0]).toMatchObject({
      title: 'Run Vitest suite',
      framework: 'Vitest',
      status: 'passed',
    })
    expect(runtime.externalCalls[0]).toMatchObject({
      title: 'Fetch GitHub issue',
      category: 'vcs',
    })
    expect(JSON.stringify(runtime)).not.toContain('--secret')
  })

  test('opens a live agent in the clearly labeled Session Console', async ({ page }) => {
    await page.goto('/')

    await page.getByRole('button', { name: 'Open Session' }).click()

    await expect(page.getByRole('dialog', { name: /Session console:/ })).toBeVisible()
    await expect(page.getByText(/SESSION CONSOLE/)).toBeVisible()
    await expect(page.getByText('Chat with this agent, review its activity, and inspect changes.')).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Session console sections' })).toBeVisible()
    await expect(page.getByPlaceholder('Send a follow-up to this session…')).toBeVisible()
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
    expect(body).not.toContain('Run Vitest suite')
    expect(body).not.toContain('Fetch GitHub issue')
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

  test('recovers the ACP control channel after its child process exits', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Control/ }).click()

    await expect(page.getByText('ACP CONTROL LINKED')).toBeVisible({ timeout: 10_000 })
    const response = await page.request.post('/api/control/sessions', {
      data: {
        cwd: workspace,
        prompt: 'Crash control process fixture',
      },
    })
    expect(response.ok()).toBe(true)
    const created = await response.json()

    await expect.poll(async () => {
      const snapshot = await (await page.request.get('/api/control')).json()
      return {
        connected: snapshot.connected,
        disconnected: Boolean(snapshot.lastDisconnectedAt),
        state: snapshot.sessions.find((item: { id: string }) => item.id === created.id)?.state,
      }
    }, { timeout: 15_000 }).toEqual({
      connected: true,
      disconnected: true,
      state: 'failed',
    })
    const interruptedLane = page.locator('.lane-card').filter({ hasText: 'Crash control process fixture' })
    await expect(interruptedLane.getByText('CONTROL INTERRUPTED')).toBeVisible()
    await expect(interruptedLane.getByText('Simulated ACP child crash', { exact: false })).toBeVisible()
    await expect(interruptedLane.getByRole('button', { name: 'Resume' })).toBeVisible()

    const resumed = await page.request.post(`/api/control/sessions/${created.id}/prompt`, {
      data: {
        cwd: workspace,
        prompt: 'Verify recovered control session',
      },
    })
    expect(resumed.ok()).toBe(true)
    await expect.poll(async () => {
      const snapshot = await (await page.request.get('/api/control')).json()
      return snapshot.sessions.find((item: { id: string }) => item.id === created.id)?.state
    }, { timeout: 10_000 }).toBe('idle')
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

  test('persists provenance-aware usage and redacts its project report', async ({ page }) => {
    await page.goto('/')
    const created = await page.request.post('/api/control/sessions', {
      data: {
        cwd: workspace,
        prompt: 'Start workflow fixture for usage ledger verification',
      },
    })
    expect(created.ok()).toBe(true)
    const session = await created.json()

    await expect.poll(async () => {
      const report = await (await page.request.get('/api/usage?period=all&scope=sessions&groupBy=session')).json()
      return report.entries.find((entry: { sessionId: string }) => entry.sessionId === session.id)?.totalTokens
    }, { timeout: 10_000 }).toEqual({
      value: 16,
      source: 'grok-reported',
    })

    await page.getByRole('button', { name: /Usage/ }).click()
    await expect(page.getByRole('heading', { name: /Know what was used/ })).toBeVisible()
    await expect(page.getByText('Persistent usage ledger', { exact: true })).toBeVisible()
    await expect(page.getByText('Telemetry coverage')).toBeVisible()
    await expect(page.locator('.usage-ledger')).toContainText('secret-client')
    await expect(page.locator('.usage-ledger')).toContainText(/derived|incomplete/)

    const budgets = page.locator('.usage-budget-panel')
    await budgets.getByLabel('Limit').fill('1')
    await budgets.getByRole('button', { name: 'Add budget' }).click()
    await expect(budgets.getByText('All usage', { exact: true })).toBeVisible()
    await expect(budgets.locator('.usage-budget-row.is-exceeded')).toBeVisible()
    await expect(budgets.getByText(/100% threshold reached/)).toBeVisible()

    await page.getByRole('button', { name: 'Privacy' }).click()
    await expect(page.locator('.usage-ledger')).not.toContainText('secret-client')
    await expect(page.locator('.usage-ledger')).toContainText(/Workspace [A-Z0-9]{3}/)

    const exported = await page.request.get('/api/usage/export?period=all&scope=sessions&groupBy=project&format=json&privacy=1')
    expect(exported.ok()).toBe(true)
    expect(exported.headers()['content-disposition']).toContain('grok-ui-usage.json')
    const exportBody = await exported.text()
    expect(exportBody).toContain('"privacyApplied": true')
    expect(exportBody).not.toContain('secret-client')
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
    expect(await unreadableVisibleText(page)).toEqual([])

    await page.getByRole('button', { name: 'Open Session' }).click()
    await expect(page.getByRole('dialog', { name: /Session console:/ })).toBeVisible()
    await expect(page.getByText(/SESSION CONSOLE/)).toBeVisible()
    const consoleOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(consoleOverflow.scrollWidth).toBeLessThanOrEqual(consoleOverflow.clientWidth)
    expect(await unreadableVisibleText(page)).toEqual([])
  })

  test('keeps supporting text readable across every dashboard section', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto('/')

    for (const section of [
      'Live',
      'Control',
      'Runs',
      'Changes',
      'Overview',
      'Sessions',
      'Activity',
      'Library',
      'Memory',
      'Themes',
    ]) {
      await page.getByRole('button', { name: new RegExp(section, 'i') }).first().click()
      expect(await unreadableVisibleText(page), `${section} contains text below 8px`).toEqual([])
    }
  })
})
