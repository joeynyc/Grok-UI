import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GrokController } from './grok-controller.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fakeGrok = path.join(projectRoot, 'scripts', 'fake-grok-e2e.mjs')
const previousGrokBin = process.env.GROK_BIN
const cleanup: string[] = []
const controllers: GrokController[] = []

afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.stop()))
  await Promise.all(cleanup.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })))
  if (previousGrokBin === undefined) delete process.env.GROK_BIN
  else process.env.GROK_BIN = previousGrokBin
})

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for controller state.')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('GrokController cancellation', () => {
  it('surfaces a retryable failure when Grok does not confirm Stop', async () => {
    process.env.GROK_BIN = fakeGrok
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-cancel-'))
    cleanup.push(workspace)
    const controller = new GrokController(undefined, 60)
    controllers.push(controller)

    const created = await controller.createSession({
      cwd: workspace,
      prompt: 'Run the ignored cancellation verification',
    })
    await waitFor(() => controller.snapshot().sessions[0]?.feed.some((item) =>
      item.title === 'Long-running cancellation fixture') === true, 5_000)

    await controller.cancelSession(created.id)
    expect(controller.snapshot().sessions[0]).toMatchObject({
      state: 'stopping',
      cancellationStatus: 'requested',
      stopReason: 'stop_requested',
    })

    await waitFor(() => controller.snapshot().sessions[0]?.cancellationStatus === 'timed_out')
    expect(controller.snapshot().sessions[0]).toMatchObject({
      state: 'failed',
      cancellationStatus: 'timed_out',
    })
    expect(controller.snapshot().sessions[0].error).toContain('did not confirm')
  })
})

describe('GrokController recovery', () => {
  it('reconnects after the ACP child exits and reloads the interrupted session', async () => {
    process.env.GROK_BIN = fakeGrok
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-recovery-'))
    cleanup.push(workspace)
    const controller = new GrokController(undefined, 12_000, 20)
    controllers.push(controller)

    const created = await controller.createSession({
      cwd: workspace,
      prompt: 'Crash control process fixture',
    })
    await waitFor(() => Boolean(controller.snapshot().lastDisconnectedAt), 5_000)
    await waitFor(() => controller.snapshot().connected, 5_000)

    expect(controller.snapshot()).toMatchObject({
      connected: true,
      reconnecting: false,
      reconnectAttempt: 0,
    })
    expect(controller.snapshot().sessions[0]).toMatchObject({
      id: created.id,
      state: 'failed',
      stopReason: 'control_disconnected',
    })
    expect(controller.snapshot().sessions[0].error).toContain('Simulated ACP child crash')

    await controller.promptSession({
      sessionId: created.id,
      cwd: workspace,
      prompt: 'Verify recovered control session',
    })
    await waitFor(() => controller.snapshot().sessions[0]?.state === 'idle', 5_000)
    expect(controller.snapshot().sessions[0]).toMatchObject({
      id: created.id,
      state: 'idle',
      error: '',
    })
  }, 15_000)
})

describe('GrokController workflows', () => {
  it('collects cross-session telemetry and resumes a failed run through Grok', async () => {
    process.env.GROK_BIN = fakeGrok
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-workflow-'))
    cleanup.push(workspace)
    const controller = new GrokController()
    controllers.push(controller)

    const created = await controller.createSession({
      cwd: workspace,
      prompt: 'Start workflow fixture',
    })
    await waitFor(() => controller.snapshot().workflows[0]?.status === 'failed', 5_000)

    expect(controller.snapshot().workflows[0]).toMatchObject({
      id: 'workflow-run-1',
      sessionId: created.id,
      displayName: 'release-check',
      status: 'failed',
      currentPhase: 'verify',
      agentBudget: 8,
      agentsUsed: 4,
      totalTokens: 6_400,
      tokenTelemetryAvailable: true,
      elapsedMs: 58_000,
      canResume: true,
    })

    await waitFor(() => controller.snapshot().sessions[0]?.state === 'idle', 5_000)
    await controller.controlWorkflow(created.id, 'workflow-run-1', 'resume')
    await waitFor(() => controller.snapshot().workflows[0]?.status === 'completed', 5_000)

    expect(controller.snapshot().workflows[0]).toMatchObject({
      status: 'completed',
      resultSummary: 'Release verified and ready to ship.',
      agentsUsed: 5,
      totalTokens: 9_100,
      canResume: false,
    })
    expect(controller.snapshot().sessions[0]?.lastPrompt).toBe('/workflow resume release-check')
  })
})
