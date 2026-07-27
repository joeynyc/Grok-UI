import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const fixtureRoot = path.join(os.tmpdir(), 'grok-ui-e2e')

interface FleetFixture {
  fleetControlFile: string
  fleetHosts: Record<string, { url: string; token: string }>
}

async function fixture(): Promise<FleetFixture> {
  return JSON.parse(await fs.readFile(path.join(fixtureRoot, 'fixture.json'), 'utf8')) as FleetFixture
}

async function registerHost(
  request: APIRequestContext,
  label: string,
  target: { url: string; token: string },
  options: { transport?: 'direct' | 'tailscale'; enabled?: boolean } = {},
) {
  const response = await request.post('/api/fleet/hosts', {
    data: {
      label,
      transport: options.transport || 'direct',
      baseUrl: target.url,
      token: target.token,
      enabled: options.enabled !== false,
    },
  })
  const body = await response.json()
  expect(response.status(), JSON.stringify(body)).toBe(201)
  return body
}

async function fleetStatus(request: APIRequestContext, label: string): Promise<string> {
  const response = await request.get('/api/fleet')
  expect(response.ok()).toBe(true)
  const fleet = await response.json()
  return fleet.hosts.find((host: { label: string }) => host.label === label)?.status || 'missing'
}

async function fleetHostId(request: APIRequestContext, label: string): Promise<string> {
  const fleet = await (await request.get('/api/fleet')).json()
  return fleet.hosts.find((host: { label: string }) => host.label === label)?.id || ''
}

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

test.describe.serial('read-only fleet monitoring', () => {
  test('registers multiple hosts and exposes bounded read-only telemetry with explicit states', async ({ page }) => {
    const setup = await fixture()
    await page.goto('/')
    await page.getByRole('button', { name: /Fleet/ }).click()

    await page.getByRole('button', { name: 'Register host' }).first().click()
    const editor = page.getByRole('dialog', { name: 'Register a host' })
    await editor.getByLabel('Display name').fill('Healthy Workstation')
    await editor.getByLabel('Transport').selectOption('direct')
    await editor.getByLabel('Loopback agent URL').fill(setup.fleetHosts.healthy.url)
    await editor.getByLabel(/Agent token/).fill(setup.fleetHosts.healthy.token)
    await editor.getByRole('button', { name: 'Register host' }).click()

    await registerHost(page.request, 'Degraded Workstation', setup.fleetHosts.degraded)
    await registerHost(page.request, 'Future Protocol Workstation', setup.fleetHosts.incompatible)
    await registerHost(page.request, 'Unauthorized Workstation', setup.fleetHosts.unauthorized)

    await expect.poll(() => fleetStatus(page.request, 'Healthy Workstation'), {
      timeout: 15_000,
    }).toBe('healthy')
    await expect.poll(() => fleetStatus(page.request, 'Degraded Workstation'), {
      timeout: 15_000,
    }).toBe('degraded')
    await expect.poll(() => fleetStatus(page.request, 'Future Protocol Workstation'), {
      timeout: 15_000,
    }).toBe('incompatible')
    await expect.poll(() => fleetStatus(page.request, 'Unauthorized Workstation'), {
      timeout: 15_000,
    }).toBe('unauthorized')

    await registerHost(
      page.request,
      'Disabled Tailnet Workstation',
      { url: 'http://100.64.0.2:4311', token: 'disabled-tailnet-token' },
      { transport: 'tailscale', enabled: false },
    )
    const connecting = await registerHost(
      page.request,
      'Connecting Workstation',
      { url: 'http://127.0.0.1:65534', token: 'unreachable-agent-token' },
    )
    expect(connecting.fleet.hosts.find(
      (host: { label: string }) => host.label === 'Connecting Workstation',
    )?.status).toBe('connecting')

    await expect(page.getByText('Healthy Workstation').first()).toBeVisible()
    await expect(page.getByText('Degraded Workstation').first()).toBeVisible()
    await expect(page.getByText('Future Protocol Workstation').first()).toBeVisible()
    await expect(page.getByText('Unauthorized Workstation').first()).toBeVisible()
    await expect(page.getByText('Disabled Tailnet Workstation').first()).toBeVisible()
    await expect(page.getByText('Connecting Workstation').first()).toBeVisible()
    await expect(page.locator('.fleet-host-row .status-healthy')).toHaveCount(1)
    await expect(page.locator('.fleet-host-row .status-degraded')).toHaveCount(1)
    await expect(page.locator('.fleet-host-row .status-incompatible')).toHaveCount(1)
    await expect(page.locator('.fleet-host-row .status-unauthorized')).toHaveCount(1)
    await expect(page.locator('.fleet-host-row .status-unavailable')).toHaveCount(1)
    await expect(page.locator('.fleet-host-row').filter({ hasText: 'Connecting Workstation' })
      .locator('.status-connecting')).toBeVisible()

    await page.locator('.fleet-host-row').filter({ hasText: 'Healthy Workstation' }).click()
    await expect(page.getByText('0.10.0-e2e').first()).toBeVisible()
    await expect(page.getByText('sessions.list')).toBeVisible()
    await expect(page.getByText('Freshness').first()).toBeVisible()
    await expect(page.getByText('fresh', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Read only', { exact: true })).toBeVisible()

    await page.getByRole('tab', { name: 'Sessions' }).click()
    await expect(page.getByText('Remote Confidential Phoenix')).toBeVisible()
    await expect(page.getByText('secret-phoenix').first()).toBeVisible()
    await page.getByRole('button', { name: /Inspect read-only session Remote Confidential Phoenix/ }).click()
    await expect(page.getByText('Remote transcript for Example Operator at 100.64.0.9')).toBeVisible()

    await page.getByRole('tab', { name: 'Runs' }).click()
    await expect(page.getByText('Remote Fleet Workflow')).toBeVisible()
    await expect(page.getByText('Coordinate the confidential Phoenix verification.')).toBeVisible()

    await page.getByRole('tab', { name: 'Runtime' }).click()
    await expect(page.getByText('secret-remote-dev-server')).toBeVisible()
    await expect(page.getByText('Phoenix dev server')).toBeVisible()
    await expect(page.getByText('Remote Fleet Vitest')).toBeVisible()

    await page.getByRole('tab', { name: 'Usage' }).click()
    await expect(page.getByText('1,234').first()).toBeVisible()
    await expect(page.getByText('secret-phoenix').first()).toBeVisible()

    for (const control of [
      /^Start$/i,
      /^Pause$/i,
      /^Resume$/i,
      /^Interrupt$/i,
      /^Stop$/i,
      /^Approve$/i,
      /^Execute shell$/i,
    ]) {
      await expect(page.getByRole('button', { name: control })).toHaveCount(0)
    }

    await page.getByRole('button', { name: 'Privacy' }).click()
    await expect(page.getByRole('button', { name: 'Privacy on' })).toHaveAttribute('aria-pressed', 'true')
    const privatePanels: string[] = []
    for (const tab of ['Overview', 'Sessions', 'Runs', 'Runtime', 'Usage']) {
      await page.getByRole('tab', { name: tab }).click()
      if (tab === 'Sessions') {
        await page.locator('.fleet-inspect-session').first().click()
        await expect(page.locator('.fleet-session-detail')).toBeVisible()
      }
      privatePanels.push(await page.locator('body').innerText())
    }
    const privateBody = privatePanels.join('\n')
    for (const sensitive of [
      'Healthy Workstation',
      'Healthy Secret Workstation',
      setup.fleetHosts.healthy.url,
      'Remote Confidential Phoenix',
      'secret-phoenix',
      'Example Operator',
      '100.64.0.9',
      'Remote Fleet Workflow',
      'secret-remote-dev-server',
      'Phoenix dev server',
      'Remote Fleet Vitest',
      'grok-fleet-e2e',
      'Vitest',
      '5173',
    ]) {
      expect(privateBody).not.toContain(sensitive)
    }
    await page.reload()
    await page.getByRole('button', { name: /Fleet/ }).click()
    await expect(page.getByRole('button', { name: 'Privacy on' })).toHaveAttribute('aria-pressed', 'true')
    expect(await page.locator('body').innerText()).not.toContain('Healthy Workstation')
  })

  test('transitions a disconnected host through stale and offline before reconnecting', async ({ page }) => {
    test.setTimeout(90_000)
    const setup = await fixture()
    const hostId = await fleetHostId(page.request, 'Healthy Workstation')
    expect(hostId).toBeTruthy()

    await fs.writeFile(setup.fleetControlFile, JSON.stringify({ healthy: 'offline' }))
    const disconnected = await page.request.post(`/api/fleet/hosts/${hostId}/refresh`)
    expect(disconnected.ok()).toBe(true)

    await expect.poll(() => fleetStatus(page.request, 'Healthy Workstation'), {
      timeout: 22_000,
      intervals: [500, 1_000],
    }).toBe('stale')
    await page.goto('/')
    await page.getByRole('button', { name: /Fleet/ }).click()
    await page.locator('.fleet-host-row').filter({ hasText: 'Healthy Workstation' }).click()
    await expect(page.locator('.fleet-status-narrative.status-stale')).toBeVisible()
    await page.getByRole('tab', { name: 'Sessions' }).click()
    await expect(page.getByText(/Cached sessions snapshot/)).toBeVisible()

    await expect.poll(() => fleetStatus(page.request, 'Healthy Workstation'), {
      timeout: 42_000,
      intervals: [1_000],
    }).toBe('offline')

    await expect(page.locator('.fleet-status-narrative.status-offline')).toBeVisible()
    await expect(page.getByText(/Cached sessions snapshot/)).toBeVisible()

    await fs.writeFile(setup.fleetControlFile, JSON.stringify({ healthy: 'online' }))
    const reconnected = await page.request.post(`/api/fleet/hosts/${hostId}/refresh`)
    expect(reconnected.ok()).toBe(true)
    await expect.poll(() => fleetStatus(page.request, 'Healthy Workstation'), {
      timeout: 10_000,
    }).toBe('healthy')
    await expect(page.locator('.fleet-status-narrative.status-healthy')).toBeVisible()

    const disabled = await page.request.patch(`/api/fleet/hosts/${hostId}`, {
      data: { enabled: false },
    })
    expect(disabled.ok()).toBe(true)
    await expect.poll(() => fleetStatus(page.request, 'Healthy Workstation')).toBe('unavailable')
    await expect(page.locator('.fleet-status-narrative.status-unavailable')).toBeVisible()
    await expect(page.getByText(/Cached sessions snapshot/)).toBeVisible()

    const reenabled = await page.request.patch(`/api/fleet/hosts/${hostId}`, {
      data: { enabled: true },
    })
    expect(reenabled.ok()).toBe(true)
    await expect.poll(() => fleetStatus(page.request, 'Healthy Workstation'), {
      timeout: 10_000,
    }).toBe('healthy')
  })

  test('keeps the fleet view readable and within a mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await page.getByRole('button', { name: 'Fleet Monitor' }).click()
    await expect(page.getByRole('heading', { name: /Every host/ })).toBeVisible()
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)
    expect(await unreadableVisibleText(page)).toEqual([])
  })
})
