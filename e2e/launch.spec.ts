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
