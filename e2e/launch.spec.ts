import { expect, test, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const fixtureRoot = path.join(os.tmpdir(), 'grok-ui-e2e')
const grokHome = path.join(fixtureRoot, 'grok-home')
const workspace = path.join(fixtureRoot, 'secret-client')
const sessionId = 'live-e2e-session'
const fleetFixtureFile = path.join(fixtureRoot, 'fixture.json')

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
    fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({
      scripts: { dev: 'node preview-server.mjs' },
    })),
    fs.writeFile(path.join(workspace, 'preview-server.mjs'), `
      import http from 'node:http'
      const port = Number(process.env.PORT)
      const host = process.env.HOST
      http.createServer((_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end('<main><h1>Build preview online</h1><p>Session-scoped loopback app</p></main>')
      }).listen(port, host, () => console.log('e2e preview ready on ' + host + ':' + port))
    `),
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

async function registerControlledFleetHost(page: Page) {
  const current = await (await page.request.get('/api/fleet')).json()
  const existing = current.hosts.find((host: { label: string }) => host.label === 'Mobile Build Mac')
  if (existing) return existing.id as string

  const fixture = JSON.parse(await fs.readFile(fleetFixtureFile, 'utf8')) as {
    fleetHosts: {
      healthy: { url: string; token: string; controlToken: string }
    }
  }
  const created = await page.request.post('/api/fleet/hosts', {
    data: {
      label: 'Mobile Build Mac',
      transport: 'direct',
      baseUrl: fixture.fleetHosts.healthy.url,
      token: fixture.fleetHosts.healthy.token,
      controlEnabled: true,
      controlToken: fixture.fleetHosts.healthy.controlToken,
    },
  })
  expect(created.ok()).toBe(true)
  const hostId = (await created.json()).host.id as string

  await expect.poll(async () => {
    await page.request.post(`/api/fleet/hosts/${hostId}/refresh`)
    const fleet = await (await page.request.get('/api/fleet')).json()
    return fleet.hosts.find((host: { id: string }) => host.id === hostId)?.status
  }, { timeout: 10_000 }).toBe('healthy')

  return hostId
}

test.describe.serial('public launch path', () => {
  test('defaults a fresh browser to the Event Horizon theme', async ({ page }) => {
    await page.goto('/')

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'event-horizon')
    expect(await page.evaluate(() => localStorage.getItem('grok-ui-theme'))).toBe('event-horizon')
  })

  test('applies and persists the Minimal Calm theme with restrained decorative motion', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Themes/ }).click()

    const calmTheme = page.getByRole('button', { name: /Minimal Calm/ })
    await expect(calmTheme).toBeVisible()
    await expect(calmTheme.getByText('03 / 03')).toBeVisible()
    await calmTheme.click()

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'minimal-calm')
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#f7f7f4')
    expect(await page.evaluate(() => localStorage.getItem('grok-ui-theme'))).toBe('minimal-calm')
    expect(await page.locator('html').evaluate((element) => getComputedStyle(element).colorScheme)).toBe('light')
    expect(await page.locator('.scan-beam').evaluate((element) => getComputedStyle(element).display)).toBe('none')
    expect(await page.locator('.status-dot.is-live').first().evaluate(
      (element) => getComputedStyle(element).animationName,
    )).toBe('none')

    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'minimal-calm')
    expect(await page.evaluate(() => localStorage.getItem('grok-ui-theme'))).toBe('minimal-calm')

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible()
    expect(await page.locator('.mobile-bottom-nav').evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    )).toBe('rgba(247, 247, 244, 0.96)')
    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )).toBe(0)
  })

  test('guides a clean installation through missing CLI and ready states', async ({ page }) => {
    await Promise.all([
      fs.rm(path.join(grokHome, 'e2e-cli-ready'), { force: true }),
      fs.rm(path.join(grokHome, 'active_sessions.json'), { force: true }),
      fs.rm(path.join(grokHome, 'sessions'), { recursive: true, force: true }),
    ])
    await expect.poll(async () => {
      const dashboard = await (await page.request.get('/api/dashboard?refresh=1')).json()
      const live = await (await page.request.get('/api/live')).json()
      return {
        sessions: dashboard.stats.sessions,
        active: live.activeCount,
      }
    }, { timeout: 10_000 }).toEqual({ sessions: 0, active: 0 })
    const reset = await page.request.get('/api/setup?refresh=1')
    expect(reset.ok()).toBe(true)
    const resetStatus = await reset.json()
    expect(resetStatus.ready).toBe(false)
    expect(resetStatus.checks.find((check: { id: string }) => check.id === 'cli')).toMatchObject({
      state: 'action',
      detail: 'Grok CLI is missing or cannot run.',
    })
    await page.goto('/')
    await expect(page.getByRole('heading', { name: /Zero to live/ })).toBeVisible()
    await expect(page.getByText('Setup needed')).toBeVisible()
    await expect(page.getByText('Grok CLI is missing or cannot run.')).toBeVisible()

    await fs.writeFile(path.join(grokHome, 'e2e-cli-ready'), 'unauthenticated\n')
    await page.getByRole('button', { name: /Recheck setup/ }).click()

    await expect(page.getByText('Setup needed')).toBeVisible()
    await expect(page.getByText('Grok Build e2e')).toBeVisible()
    await expect(page.getByText('Authentication is required.')).toBeVisible()

    await fs.writeFile(path.join(grokHome, 'e2e-cli-ready'), 'ready\n')
    await page.getByRole('button', { name: /Recheck setup/ }).click()

    await expect(page.getByText('Ready to start')).toBeVisible()
    await expect(page.getByText('Environment ready.')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Start a session' })).toBeVisible()
    await expect(page.getByLabel('WORKSPACE')).toBeVisible()
    await expect(page.getByLabel('INSTRUCTION')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start session' })).toBeVisible()
    await expect(page).toHaveURL(/#\/live$/)
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('button', { name: /Control/ })).toHaveCount(0)
  })

  test('discovers a newly registered Grok CLI session over the live stream', async ({ page }) => {
    await page.goto('/')
    await registerLiveSession()

    await expect(page.getByText('Confidential Launch').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('1', { exact: true }).first()).toBeVisible()
    await expect(page.getByText(/secret-client/).first()).toBeVisible()
    await expect(page.getByText(/PID \d+/).first()).toBeVisible()
    await page.getByRole('button', { name: /Open Session/ }).click()
    await expect(page).toHaveURL(new RegExp(`#/live/${sessionId}$`))
    await page.locator('.session-workbench').getByRole('button', { name: 'Close session console panel' }).click()
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: /Sessions/ }).click()
    await expect(page).toHaveURL(/#\/sessions$/)
    await page.reload()
    await expect(page.getByRole('heading', { name: /Nothing buried/ })).toBeVisible()
  })

  test('reconnects the browser event stream after a server interruption', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Overview/ }).click()
    await expect(page.getByText('Updates connected')).toBeVisible()

    const disconnected = await page.request.post('/api/test/disconnect-events')
    expect(disconnected.ok()).toBe(true)
    expect((await disconnected.json()).disconnected).toBeGreaterThan(0)
    await expect(page.getByText('Updates reconnecting')).toBeVisible({ timeout: 10_000 })

    await expect(page.getByText('Updates connected')).toBeVisible({ timeout: 15_000 })
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

    const openSession = page.getByRole('button', { name: 'Open Session' })
    await openSession.click()

    const dialog = page.getByRole('dialog', { name: /Session console:/ })
    await expect(dialog).toBeVisible()
    await expect(page.getByText(/^Session · /)).toBeVisible()
    await expect(page.getByText('Chat with this agent, review its activity, and inspect changes.')).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Session console sections' })).toBeVisible()
    const prompt = page.getByPlaceholder('Send a follow-up to this session…')
    const closeButton = page.getByRole('button', { name: 'Close session console panel' })
    await expect(prompt).toBeVisible()
    await expect(closeButton).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    expect(await dialog.evaluate(
      () => document.activeElement?.classList.contains('workbench-scrim'),
    )).toBe(false)
    await page.keyboard.press('Tab')
    await expect(closeButton).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: /Session console:/ })).toHaveCount(0)
    await expect(openSession).toBeFocused()
  })

  test('redacts sensitive runtime data and persists Privacy Mode', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('Confidential Launch').first()).toBeVisible()
    await page.getByRole('button', { name: 'Open Session' }).click()
    await expect(page.getByText(/192\.168\.1\.42/)).toBeVisible()
    await page.getByRole('button', { name: 'Close session console panel' }).click()

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

  test('launches and controls a responsive session preview', async ({ page }) => {
    await page.goto('/')
    await registerLiveSession()
    await expect(page.getByText('Confidential Launch').first()).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Open Session' }).click()
    await page.getByRole('button', { name: /Preview/ }).click()

    await expect(page.getByText(/npm run dev/)).toBeVisible()
    await page.locator('.preview-toolbar').getByRole('button', { name: 'Start preview' }).click()
    await expect(page.getByText('LOOPBACK PREVIEW')).toBeVisible({ timeout: 10_000 })
    await expect(page.frameLocator('iframe[title="Session application preview"]').getByRole('heading', {
      name: 'Build preview online',
    })).toBeVisible()

    await page.getByRole('button', { name: 'Mobile preview' }).click()
    await expect(page.locator('.preview-viewport')).toHaveClass(/viewport-mobile/)
    await page.getByRole('button', { name: 'Reload preview' }).click()

    await page.locator('.preview-toolbar').getByRole('button', { name: 'Stop' }).click()
    await expect(page.getByText('Preview process stopped.')).toBeVisible()
    await expect(page.getByText('Preview is offline')).toBeVisible()
  })

  test('launches and approves a managed ACP control session', async ({ page }, testInfo) => {
    const instruction = `Run the public release verification attempt ${testInfo.repeatEachIndex + 1}-${testInfo.retry + 1}`
    await page.goto('/#/control')
    await expect(page.getByText('Control connected')).toBeVisible({ timeout: 10_000 })
    await page.getByLabel('WORKSPACE').fill(workspace)
    await page.getByLabel('INSTRUCTION').fill(instruction)
    await page.getByRole('button', { name: 'Start session' }).click()

    await expect(page.getByText('New Grok lane launched.')).toBeVisible()
    const lane = page.locator('.lane-card').filter({ hasText: instruction })
    const approval = page.locator('.approval-card').filter({ hasText: 'Write the verified fixture' }).last()
    await expect(approval).toBeVisible()
    await approval.getByRole('button', { name: 'Allow once' }).click()

    await expect.poll(async () => {
      const snapshot = await (await page.request.get('/api/control')).json()
      const session = snapshot.sessions.find((item: { title: string }) =>
        item.title === instruction)
      return session ? {
        state: session.state,
        totalTokens: session.totalTokens,
        pendingPermissions: snapshot.permissions.filter(
          (permission: { sessionId: string }) => permission.sessionId === session.id,
        ).length,
      } : null
    }, {
      timeout: 30_000,
      intervals: [100, 250, 500],
    }).toEqual({
      state: 'idle',
      totalTokens: 20,
      pendingPermissions: 0,
    })
    await expect(page.locator('.managed-stream')
      .getByText('Permission approved and command completed.')
      .last()).toBeVisible()
    await expect(lane.getByText('20', { exact: true })).toBeVisible()
  })

  test('recovers the ACP control channel after its child process exits', async ({ page }) => {
    await page.goto('/#/control')
    await expect(page.getByText('Control connected')).toBeVisible({ timeout: 10_000 })
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
    await page.goto('/#/control')
    await expect(page.getByText('Control connected')).toBeVisible({ timeout: 10_000 })
    await page.getByLabel('WORKSPACE').fill(workspace)
    await page.getByLabel('INSTRUCTION').fill('Start workflow fixture')
    await page.getByRole('button', { name: 'Start session' }).click()

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
    await page.goto('/#/control')
    await expect(page.getByText('Control connected')).toBeVisible({ timeout: 10_000 })
    await page.getByLabel('WORKSPACE').fill(workspace)
    await page.getByLabel('INSTRUCTION').fill('Start scaled workflow fixture')
    await page.getByRole('button', { name: 'Start session' }).click()

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
    await page.goto('/#/control')
    await expect(page.getByText('Control connected')).toBeVisible({ timeout: 10_000 })
    await page.getByLabel('WORKSPACE').fill(workspace)
    await page.getByLabel('INSTRUCTION').fill('Hold for permission cancellation')
    await page.getByRole('button', { name: 'Start session' }).click()

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
    await page.goto('/#/control')
    await expect(page.getByText('Control connected')).toBeVisible({ timeout: 10_000 })
    await page.getByLabel('WORKSPACE').fill(workspace)
    await page.getByLabel('INSTRUCTION').fill('Run the long-running cancellation verification')
    await page.getByRole('button', { name: 'Start session' }).click()

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
      offenders: [...document.querySelectorAll<HTMLElement>('body *')]
        .map((element) => {
          const bounds = element.getBoundingClientRect()
          return {
            selector: `${element.tagName.toLowerCase()}.${element.className}`,
            parent: element.parentElement
              ? `${element.parentElement.tagName.toLowerCase()}.${element.parentElement.className}`
              : '',
            text: element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 120),
            left: bounds.left,
            right: bounds.right,
            width: bounds.width,
          }
        })
        .filter((element) =>
          element.right > document.documentElement.clientWidth + 0.5
          || element.left < -0.5)
        .sort((left, right) => right.right - left.right)
        .slice(0, 12),
    }))
    expect(
      overflow.scrollWidth,
      `Horizontal overflow: ${JSON.stringify(overflow.offenders)}`,
    ).toBeLessThanOrEqual(overflow.clientWidth)
    expect(await unreadableVisibleText(page)).toEqual([])

    await page.getByRole('button', { name: 'Open Session' }).click()
    await expect(page.getByRole('dialog', { name: /Session console:/ })).toBeVisible()
    await expect(page.getByText(/^Session · /)).toBeVisible()
    const consoleOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(consoleOverflow.scrollWidth).toBeLessThanOrEqual(consoleOverflow.clientWidth)
    expect(await unreadableVisibleText(page)).toEqual([])
  })

  test('keeps Fleet navigation and session actions usable across phone widths', async ({ page }) => {
    await page.goto('/')
    await registerControlledFleetHost(page)

    for (const viewport of [
      { width: 360, height: 800 },
      { width: 390, height: 844 },
      { width: 430, height: 932 },
    ]) {
      await page.setViewportSize(viewport)
      await page.reload()

      const mobileNav = page.getByRole('navigation', { name: 'Mobile navigation' })
      await expect(mobileNav).toBeVisible()
      await expect(mobileNav.getByRole('button')).toHaveCount(5)
      await mobileNav.getByRole('button', { name: 'Fleet' }).click()
      await expect(page.getByRole('heading', { name: /Every host/ })).toBeVisible()

      const fleetFilter = page.locator('.fleet-filter')
      expect(await fleetFilter.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0)
      expect((await fleetFilter.getByRole('button').first().boundingBox())?.height).toBeGreaterThanOrEqual(44)

      await page.locator('.fleet-host-row').filter({ hasText: 'Mobile Build Mac' }).click()
      await page.getByRole('tab', { name: 'Sessions' }).click()
      expect(await page.locator('.fleet-tabs').evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      )).toBe(0)
      await expect(page.locator('.fleet-session-cards')).toBeVisible()
      await expect(page.locator('.fleet-session-table')).toBeHidden()

      const continueButton = page.getByRole('button', { name: /Continue remote session/ })
      const inspectButton = page.getByRole('button', { name: /Inspect read-only session/ })
      await expect(continueButton).toBeVisible()
      await expect(inspectButton).toBeVisible()
      expect((await continueButton.boundingBox())?.height).toBeGreaterThanOrEqual(44)
      expect((await inspectButton.boundingBox())?.height).toBeGreaterThanOrEqual(44)
      expect(await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )).toBe(0)

      await page.getByRole('tab', { name: 'Usage' }).click()
      const usageTable = page.locator('.fleet-usage-table')
      await expect(usageTable).toBeVisible()
      expect(await usageTable.evaluate((element) => element.scrollWidth)).toBeGreaterThanOrEqual(720)
    }

    await page.getByRole('tab', { name: 'Sessions' }).click()
    await page.setViewportSize({ width: 700, height: 900 })
    await expect(page.locator('.fleet-session-table')).toBeVisible()
    await expect(page.locator('.fleet-session-cards')).toHaveCount(0)
    await page.setViewportSize({ width: 680, height: 900 })
    await expect(page.locator('.fleet-session-cards')).toBeVisible()
    await expect(page.locator('.fleet-session-table')).toHaveCount(0)

    const mobileNav = page.getByRole('navigation', { name: 'Mobile navigation' })
    const moreButton = mobileNav.getByRole('button', { name: 'More' })
    await moreButton.click()
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeHidden()
    await expect(page.locator('.sidebar-close')).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('button', { name: /Fleet/ })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.locator('.sidebar-close')).toBeFocused()
    await page.locator('.sidebar-close').click()
    await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible()
    await expect(moreButton).toBeFocused()

    await moreButton.click()
    await page.getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('button', { name: /Usage/ })
      .click()
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeHidden()
    const mainStage = page.locator('.main-stage')
    await expect(mainStage).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(mainStage).toBeFocused()
  })

  test('keeps remote chat above mobile navigation and sends a follow-up', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    await registerControlledFleetHost(page)
    await page.reload()

    const mobileNav = page.getByRole('navigation', { name: 'Mobile navigation' })
    await mobileNav.getByRole('button', { name: 'Fleet' }).click()
    await page.locator('.fleet-host-row').filter({ hasText: 'Mobile Build Mac' }).click()
    await page.getByRole('tab', { name: 'Sessions' }).click()
    const continueButton = page.getByRole('button', { name: /Continue remote session/ })
    await continueButton.click()

    await expect(page.getByRole('dialog', { name: /Remote session:/ })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toHaveCount(0)
    const closeButton = page.getByRole('button', { name: 'Close remote session panel' })
    await expect(closeButton).toBeFocused()

    const composer = page.locator('.workbench-composer')
    const prompt = page.getByPlaceholder('Continue this Grok Build session…')
    await expect(composer).toBeVisible()
    await expect(prompt).toBeVisible()
    const composerBox = await composer.boundingBox()
    expect(composerBox).not.toBeNull()
    expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(844)

    await prompt.fill('Confirm the mobile follow-up path')
    await page.getByRole('button', { name: 'Send remote follow-up' }).click()
    await expect(page.getByText('Remote host accepted: Confirm the mobile follow-up path')).toBeVisible({
      timeout: 10_000,
    })

    await closeButton.click()
    await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible()
    await expect(continueButton).toBeFocused()

    await continueButton.click()
    await expect(closeButton).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: /Remote session:/ })).toHaveCount(0)
    await expect(continueButton).toBeFocused()
  })

  test('keeps supporting text readable across every dashboard section', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto('/')

    for (const section of [
      'live',
      'control',
      'runs',
      'changes',
      'overview',
      'sessions',
      'activity',
      'library',
      'memory',
      'themes',
    ]) {
      await page.goto(`/#/${section}`)
      expect(await unreadableVisibleText(page), `${section} contains text below 8px`).toEqual([])
    }
  })
})
