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

describe('GrokController follow-ups', () => {
  it('runs the first prompt after attaching a recorded session', async () => {
    process.env.GROK_BIN = fakeGrok
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-attach-'))
    cleanup.push(workspace)
    const controller = new GrokController()
    controllers.push(controller)

    const attached = await controller.promptSession({
      sessionId: 'recorded-cli-session',
      cwd: workspace,
      prompt: 'Verify recovered control session',
    })
    expect(attached.queue).toEqual([])
    await waitFor(() => controller.snapshot().sessions[0]?.state === 'idle')
    expect(controller.snapshot().sessions[0]).toMatchObject({
      id: 'recorded-cli-session',
      lastPrompt: 'Verify recovered control session',
      totalTokens: 7,
      queue: [],
    })
  })

  it('preserves pending permission state and executes queued prompts in order', async () => {
    process.env.GROK_BIN = fakeGrok
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-queue-'))
    cleanup.push(workspace)
    const controller = new GrokController()
    controllers.push(controller)

    const created = await controller.createSession({ cwd: workspace, prompt: 'Initial fixture' })
    await waitFor(() => controller.snapshot().permissions.length === 1)
    const permission = controller.snapshot().permissions[0]
    for (const prompt of ['First queued fixture', 'Second queued fixture']) {
      const queued = await controller.promptSession({ sessionId: created.id, cwd: workspace, prompt })
      expect(queued).toMatchObject({ state: 'attention', lastPrompt: 'Initial fixture' })
      expect(controller.snapshot().permissions).toEqual([permission])
    }
    expect(controller.snapshot().sessions[0].queue.map((item) => item.text))
      .toEqual(['First queued fixture', 'Second queued fixture'])

    controller.resolvePermission(permission.id, 'allow')
    await waitFor(() => controller.snapshot().sessions[0]?.lastPrompt === 'First queued fixture'
      && controller.snapshot().permissions.length === 1)
    expect(controller.snapshot().sessions[0].queue.map((item) => item.text))
      .toEqual(['Second queued fixture'])
    controller.resolvePermission(controller.snapshot().permissions[0].id, 'allow')
    await waitFor(() => controller.snapshot().sessions[0]?.lastPrompt === 'Second queued fixture'
      && controller.snapshot().permissions.length === 1)
    expect(controller.snapshot().sessions[0].queue).toEqual([])
    controller.resolvePermission(controller.snapshot().permissions[0].id, 'allow')
    await waitFor(() => controller.snapshot().sessions[0]?.state === 'idle')
  })
})

describe('GrokController cancellation', () => {
  it.each(['plan', 'plan_update', 'exit_plan_mode'])('keeps Stop pending after a late %s notification', async (kind) => {
    process.env.GROK_BIN = fakeGrok
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-stop-plan-'))
    cleanup.push(workspace)
    const controller = new GrokController()
    controllers.push(controller)
    const created = await controller.createSession({ cwd: workspace, prompt: 'Run the ignored cancellation verification' })
    await waitFor(() => controller.snapshot().sessions[0]?.feed.some((item) =>
      item.title === 'Long-running cancellation fixture') === true)
    await controller.cancelSession(created.id)

    // Deliver the valid ACP message after Stop while the fixture keeps its turn open.
    const notifications = controller as unknown as {
      sessionUpdate(params: unknown): void
      requestPlanExit(params: unknown): Promise<{ type: string }>
    }
    let verdict: Promise<{ type: string }> | undefined
    if (kind === 'exit_plan_mode') {
      verdict = notifications.requestPlanExit({ sessionId: created.id, planContent: 'A late plan' })
    } else {
      notifications.sessionUpdate({ sessionId: created.id, update: {
        sessionUpdate: kind,
        entries: [{ content: 'A late plan', status: 'pending', priority: 'medium' }],
      } })
    }
    await expect(controller.promptSession({
      sessionId: created.id, cwd: workspace, prompt: 'Must not queue during Stop',
    })).rejects.toThrow('Wait for Stop to finish')
    expect(controller.snapshot().sessions[0]).toMatchObject({
      state: 'stopping', cancellationStatus: 'requested', queue: [], awaitingPlanApproval: false,
    })
    if (verdict) await expect(verdict).resolves.toEqual({ type: 'abandoned' })
  })

  it('clears all queued work on Stop and resumes only the new prompt', async () => {
    process.env.GROK_BIN = fakeGrok
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-cancel-queue-'))
    cleanup.push(workspace)
    const controller = new GrokController()
    controllers.push(controller)

    const prompt = 'Run the long-running cancellation verification'
    const created = await controller.createSession({ cwd: workspace, prompt })
    await waitFor(() => controller.snapshot().sessions[0]?.feed.some((item) =>
      item.title === 'Long-running cancellation fixture') === true)
    for (const followUp of ['First discarded fixture', 'Second discarded fixture']) {
      await controller.promptSession({ sessionId: created.id, cwd: workspace, prompt: followUp })
    }
    expect(controller.snapshot().sessions[0]).toMatchObject({ state: 'working', lastPrompt: prompt })
    expect(controller.snapshot().sessions[0].queue).toHaveLength(2)

    await controller.cancelSession(created.id)
    expect(controller.snapshot().sessions[0].queue).toEqual([])
    await waitFor(() => controller.snapshot().sessions[0]?.state === 'cancelled')
    expect(controller.snapshot().sessions[0]).toMatchObject({ cancellationStatus: 'confirmed', queue: [] })
    await controller.promptSession({
      sessionId: created.id,
      cwd: workspace,
      prompt: 'Verify recovered control session',
    })
    await waitFor(() => ['idle', 'attention'].includes(controller.snapshot().sessions[0]?.state))
    expect(controller.snapshot().sessions[0]).toMatchObject({
      state: 'idle',
      lastPrompt: 'Verify recovered control session',
      totalTokens: 7,
      queue: [],
    })
    expect(controller.snapshot().permissions).toEqual([])
  })

  it('clears the entire queue when the active prompt completes as cancelled', async () => {
    process.env.GROK_BIN = fakeGrok
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-cancel-result-'))
    cleanup.push(workspace)
    const controller = new GrokController()
    controllers.push(controller)

    const created = await controller.createSession({ cwd: workspace, prompt: 'Permission fixture' })
    await waitFor(() => controller.snapshot().permissions.length === 1)
    const permission = controller.snapshot().permissions[0]
    for (const prompt of ['First discarded fixture', 'Second discarded fixture']) {
      await controller.promptSession({ sessionId: created.id, cwd: workspace, prompt })
    }
    controller.resolvePermission(permission.id)
    await waitFor(() => controller.snapshot().sessions[0]?.state === 'cancelled')
    expect(controller.snapshot().sessions[0].queue).toEqual([])
  })

  it('rejects follow-ups during Stop and keeps discarded work out of a later resume after timeout', async () => {
    process.env.GROK_BIN = fakeGrok
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-stopping-queue-'))
    cleanup.push(workspace)
    const controller = new GrokController(undefined, 200)
    controllers.push(controller)

    const prompt = 'Run the ignored cancellation verification'
    const created = await controller.createSession({ cwd: workspace, prompt })
    await waitFor(() => controller.snapshot().sessions[0]?.feed.some((item) =>
      item.title === 'Long-running cancellation fixture') === true)
    for (const followUp of ['First discarded fixture', 'Second discarded fixture']) {
      await controller.promptSession({ sessionId: created.id, cwd: workspace, prompt: followUp })
    }
    await controller.cancelSession(created.id)
    const stopping = controller.snapshot().sessions[0]
    expect(stopping.queue).toEqual([])
    await expect(controller.promptSession({
      sessionId: created.id,
      cwd: workspace,
      prompt: 'Follow-up while stopping',
    })).rejects.toThrow('Wait for Stop to finish before sending another prompt.')
    expect(controller.snapshot().sessions[0]).toEqual(stopping)
    expect(controller.snapshot().sessions[0]).toMatchObject({
      state: 'stopping',
      lastPrompt: prompt,
      cancellationStatus: 'requested',
      stopReason: 'stop_requested',
    })
    await waitFor(() => controller.snapshot().sessions[0]?.cancellationStatus === 'timed_out')
    expect(controller.snapshot().sessions[0]).toMatchObject({ state: 'failed', queue: [] })
    await controller.promptSession({
      sessionId: created.id,
      cwd: workspace,
      prompt: 'Verify recovered control session',
    })
    await waitFor(() => ['idle', 'attention'].includes(controller.snapshot().sessions[0]?.state))
    expect(controller.snapshot().sessions[0]).toMatchObject({
      state: 'idle',
      lastPrompt: 'Verify recovered control session',
      totalTokens: 7,
      queue: [],
    })
    expect(controller.snapshot().permissions).toEqual([])
  })

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

describe('GrokController plan review', () => {
  it('projects a plan and approves it through Grok’s exit_plan_mode request', async () => {
    process.env.GROK_BIN = fakeGrok
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-plan-'))
    cleanup.push(workspace)
    const controller = new GrokController()
    controllers.push(controller)

    const created = await controller.createSession({
      cwd: workspace,
      prompt: 'Draft a plan fixture',
      planMode: true,
    })
    await waitFor(() => controller.snapshot().sessions[0]?.awaitingPlanApproval === true, 5_000)
    expect(controller.snapshot().sessions[0]?.todos).toHaveLength(2)

    await controller.reviewPlan(created.id, 'approve')
    await waitFor(() => controller.snapshot().sessions[0]?.plan?.status === 'planning', 5_000)
    expect(controller.snapshot().sessions[0]?.lastPrompt).toBe('Draft a plan fixture')
    expect(controller.snapshot().sessions[0]?.awaitingPlanApproval).toBe(false)

    const followOn = await controller.createSession({
      cwd: workspace,
      prompt: 'Write a fixture after plan review',
    })
    await waitFor(() => {
      const row = controller.snapshot().sessions.find((item) => item.id === followOn.id)
      return row?.state === 'attention'
        && controller.snapshot().permissions.some((item) => item.sessionId === followOn.id)
    }, 5_000)
    const permission = controller.snapshot().permissions.find((item) => item.sessionId === followOn.id)
    expect(permission).toBeTruthy()
    controller.resolvePermission(permission!.id, 'allow')
    await waitFor(() => {
      const row = controller.snapshot().sessions.find((item) => item.id === followOn.id)
      return row?.state === 'idle' && row.totalTokens === 20
    }, 5_000)
  })
})
