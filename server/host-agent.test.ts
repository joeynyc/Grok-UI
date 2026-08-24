import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { request as httpRequest } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  FLEET_PROTOCOL_VERSION,
  MAX_AGENT_BODY_BYTES,
} from './fleet-protocol.js'
import { LocalHostAgentProvider, startHostAgent, type HostAgentProvider } from './host-agent.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })))
})

function usage() {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    period: '30d' as const,
    scope: 'sessions' as const,
    from: '2025-12-01T00:00:00.000Z',
    to: '2026-01-01T00:00:00.000Z',
    groupBy: 'project' as const,
    entries: [],
    totals: {
      key: 'all',
      label: 'All usage',
      entries: 0,
      sessions: 0,
      inputTokens: { value: null, source: 'unavailable' as const },
      outputTokens: { value: null, source: 'unavailable' as const },
      totalTokens: { value: null, source: 'unavailable' as const },
      costs: [{ value: null, source: 'unavailable' as const, currency: '' }],
      updatedAt: '',
    },
    groups: [],
    coverage: { 'grok-reported': 0, derived: 0, incomplete: 0, unavailable: 0 },
  }
}

function provider(): HostAgentProvider {
  const workflow = {
    id: 'workflow-1',
    controlHandle: 'unsafe-control',
    displayName: 'Remote workflow',
    sessionId: 'session-1',
    objective: 'Observe only',
    foreground: false,
    status: 'running' as const,
    phases: [],
    currentPhase: '',
    agentBudget: 1,
    agentsUsed: 1,
    agentsReserved: 0,
    agentsRemaining: 0,
    usageIncomplete: false,
    activeAgents: 1,
    currentAgentLabel: 'Observer',
    agents: [],
    totalTokens: 10,
    tokenTelemetryAvailable: true,
    elapsedMs: 100,
    lastEvent: 'running',
    lastEventDetail: '',
    lastEventAt: '2026-01-01T00:00:00.000Z',
    pauseMessage: '',
    resultSummary: '',
    updatedAt: '2026-01-01T00:00:00.000Z',
    canPause: true,
    canResume: true,
    canStop: true,
  }
  const session = {
    id: 'session-1',
    title: 'Remote session',
    summary: '',
    cwd: '/workspace',
    workspace: 'workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    model: 'grok',
    agent: 'Grok CLI',
    reasoningEffort: 'default',
    sandboxProfile: 'default',
    messages: 1,
    chatMessages: 1,
    turns: 1,
    toolCalls: 0,
    errors: 0,
    filesTouched: 0,
    linesAdded: 0,
    linesRemoved: 0,
    durationSeconds: 1,
    contextUsage: 0,
    status: 'live' as const,
    diskBytes: 0,
    archived: false,
  }
  return {
    async hello() {
      return {
        protocolVersion: FLEET_PROTOCOL_VERSION,
        protocolMin: 1,
        protocolMax: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        host: { id: 'remote', label: 'Remote', hostname: 'remote', platform: 'linux', arch: 'arm64' },
        grokUiVersion: '0.10.0',
        agentVersion: '0.10.0',
        grokVersion: 'grok-test',
        capabilities: ['sessions.list', 'sessions.detail', 'workflows.list', 'runtime.snapshot', 'usage.report'],
      }
    },
    async snapshot() {
      return {
        ...(await this.hello()),
        health: { status: 'healthy' as const, detail: '' },
        sessions: [session],
        workflows: [workflow],
        runtime: null,
        usage: usage(),
        sections: {
          sessions: 'available' as const,
          workflows: 'available' as const,
          runtime: 'unavailable' as const,
          usage: 'available' as const,
        },
        truncated: { sessions: false, workflows: false, usageEntries: false },
      }
    },
    async session() {
      return {
        protocolVersion: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        hostId: 'remote',
        session,
        transcript: [],
        live: null,
        control: null,
        workflows: [workflow],
        managed: true,
      }
    },
    async usage() {
      return usage()
    },
  }
}

describe('read-only host agent protocol', () => {
  it('requires its distinct bearer token and exposes only GET/HEAD observation routes', async () => {
    const agent = await startHostAgent({
      host: '127.0.0.1',
      port: 0,
      token: 'agent-secret',
      provider: provider(),
    })
    try {
      expect((await fetch(`${agent.url}/agent/v1/hello`)).status).toBe(401)
      expect((await fetch(`${agent.url}/agent/v1/hello`, {
        headers: { Authorization: 'Bearer wrong' },
      })).status).toBe(401)
      expect((await fetch(`${agent.url}/agent/v1/hello`, {
        method: 'POST',
        headers: { Authorization: 'Bearer agent-secret' },
      })).status).toBe(405)
      expect((await fetch(`${agent.url}/agent/v1/control`, {
        headers: { Authorization: 'Bearer agent-secret' },
      })).status).toBe(404)
    } finally {
      await agent.close()
    }
  })

  it('strips every workflow control and keeps protocol responses under the body cap', async () => {
    const agent = await startHostAgent({
      host: '127.0.0.1',
      port: 0,
      token: 'agent-secret',
      provider: provider(),
    })
    try {
      const response = await fetch(`${agent.url}/agent/v1/snapshot`, {
        headers: { Authorization: 'Bearer agent-secret' },
      })
      const body = await response.text()
      const snapshot = JSON.parse(body)
      expect(response.status).toBe(200)
      expect(Buffer.byteLength(body)).toBeLessThan(MAX_AGENT_BODY_BYTES)
      expect(snapshot.workflows[0]).toMatchObject({
        controlHandle: '',
        canPause: false,
        canResume: false,
        canStop: false,
      })
      expect(body).not.toContain('unsafe-control')
      expect(body).not.toContain('permissions')
    } finally {
      await agent.close()
    }
  })
})

describe('secure remote session protocol', () => {
  it('uses a separate control credential and executes a retried follow-up only once', async () => {
    const base = provider()
    let promptCalls = 0
    const controlled: HostAgentProvider = {
      ...base,
      async remoteSession(id) {
        const detail = await base.session(id)
        if (!detail) return null
        return {
          ...detail,
          revision: 'revision-1',
          permissions: [{
            id: 'permission-1',
            sessionId: 'session-1',
            title: 'Allow the exact tool?',
            toolKind: 'execute',
            toolCallId: 'tool-1',
            createdAt: '2026-01-01T00:00:00.000Z',
            options: [{ id: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
          }],
        }
      },
      async promptRemoteSession() {
        promptCalls += 1
      },
      async interruptRemoteSession() {},
      async resolveRemotePermission() {},
      async createRemoteSession() {
        return 'session-created'
      },
    }
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-agent-control-'))
    cleanup.push(directory)
    const agent = await startHostAgent({
      host: '127.0.0.1',
      port: 0,
      token: 'observe-secret',
      controlToken: 'control-secret',
      stateDirectory: directory,
      provider: controlled,
    })
    const controlHeaders = {
      Authorization: 'Bearer control-secret',
      'Content-Type': 'application/json',
    }
    try {
      expect((await fetch(`${agent.url}/agent/control/v1/sessions/session-1`, {
        headers: { Authorization: 'Bearer observe-secret' },
      })).status).toBe(401)
      const snapshot = await fetch(`${agent.url}/agent/control/v1/sessions/session-1`, {
        headers: { Authorization: 'Bearer control-secret' },
      })
      expect(snapshot.status).toBe(200)
      expect(await snapshot.json()).toMatchObject({
        revision: 'revision-1',
        permissions: [{ id: 'permission-1', options: [{ id: 'allow-once' }] }],
      })

      const body = JSON.stringify({
        commandId: 'follow-up-1',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        prompt: 'Continue safely',
      })
      const first = await fetch(`${agent.url}/agent/control/v1/sessions/session-1/prompt`, {
        method: 'POST',
        headers: controlHeaders,
        body,
      })
      const retry = await fetch(`${agent.url}/agent/control/v1/sessions/session-1/prompt`, {
        method: 'POST',
        headers: controlHeaders,
        body,
      })
      expect(first.status).toBe(202)
      expect(retry.status).toBe(202)
      expect(await first.json()).toMatchObject({
        commandId: 'follow-up-1',
        status: 'completed',
        sessionId: 'session-1',
      })
      expect(await retry.json()).toMatchObject({ commandId: 'follow-up-1', status: 'completed' })
      expect(promptCalls).toBe(1)

      expect((await fetch(`${agent.url}/agent/control/v1/arbitrary`, {
        method: 'POST',
        headers: controlHeaders,
        body: JSON.stringify({ commandId: 'bad-route' }),
      })).status).toBe(404)
      expect((await fetch(`${agent.url}/agent/v1/snapshot`, {
        headers: { Authorization: 'Bearer control-secret' },
      })).status).toBe(401)
    } finally {
      await agent.close()
    }
  })

  it('does not replay a completed command when its acknowledgement is lost before restart', async () => {
    const base = provider()
    let promptCalls = 0
    let markStarted!: () => void
    let finishOperation!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const operationGate = new Promise<void>((resolve) => { finishOperation = resolve })
    const controlled: HostAgentProvider = {
      ...base,
      async remoteSession(id) {
        const detail = await base.session(id)
        return detail ? { ...detail, revision: 'revision-1', permissions: [] } : null
      },
      async promptRemoteSession() {
        promptCalls += 1
        markStarted()
        await operationGate
      },
    }
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-lost-ack-'))
    cleanup.push(directory)
    const first = await startHostAgent({
      host: '127.0.0.1',
      port: 0,
      token: 'observe-secret',
      controlToken: 'control-secret',
      stateDirectory: directory,
      provider: controlled,
    })
    const command = {
      commandId: 'lost-ack-command',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      prompt: 'Execute exactly once',
    }
    let clientRequest: ReturnType<typeof httpRequest>
    const disconnectedClient = new Promise<void>((resolve) => {
      clientRequest = httpRequest(
        `${first.url}/agent/control/v1/sessions/session-1/prompt`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer control-secret',
            'Content-Type': 'application/json',
          },
        },
        (response) => {
          response.resume()
          response.once('end', resolve)
        },
      )
      clientRequest.once('error', () => resolve())
      clientRequest.end(JSON.stringify(command))
    })
    try {
      await started
      clientRequest!.destroy()
      finishOperation()
      const stateFile = path.join(directory, 'remote-commands.json')
      const deadline = Date.now() + 3_000
      while (true) {
        try {
          const state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as {
            commands?: Array<{ commandId?: string; outcome?: string }>
          }
          if (state.commands?.some((item) =>
            item.commandId === command.commandId && item.outcome === 'completed')) break
        } catch {
          // The request is still being durably reconciled.
        }
        if (Date.now() >= deadline) throw new Error('Command did not reach durable completion.')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      await disconnectedClient
    } finally {
      finishOperation()
      await first.close()
    }

    const restarted = await startHostAgent({
      host: '127.0.0.1',
      port: 0,
      token: 'observe-secret',
      controlToken: 'control-secret',
      stateDirectory: directory,
      provider: controlled,
    })
    try {
      const retry = await fetch(
        `${restarted.url}/agent/control/v1/sessions/session-1/prompt`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer control-secret',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(command),
        },
      )
      expect(retry.status).toBe(202)
      expect(await retry.json()).toMatchObject({
        commandId: 'lost-ack-command',
        status: 'completed',
      })
      expect(promptCalls).toBe(1)
    } finally {
      await restarted.close()
    }
  })

  it('refuses to turn an observation credential into a control credential', async () => {
    await expect(startHostAgent({
      host: '127.0.0.1',
      port: 0,
      token: 'same-secret',
      controlToken: 'same-secret',
      provider: provider(),
    })).rejects.toThrow(/separate/i)
  })

  it('fails closed when a permission is revoked or substituted across sessions', async () => {
    const base = provider()
    let pending = true
    let resolveCalls = 0
    const controlled: HostAgentProvider = {
      ...base,
      async remoteSession(id) {
        const detail = await base.session(id)
        if (!detail) return null
        return {
          ...detail,
          revision: pending ? 'pending-revision' : 'revoked-revision',
          permissions: pending ? [{
            id: 'permission-1',
            sessionId: 'session-1',
            title: 'Allow the exact tool?',
            toolKind: 'execute',
            toolCallId: 'tool-1',
            createdAt: '2026-01-01T00:00:00.000Z',
            options: [{ id: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
          }] : [],
        }
      },
      async resolveRemotePermission() {
        resolveCalls += 1
      },
    }
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-agent-revoked-'))
    cleanup.push(directory)
    const agent = await startHostAgent({
      host: '127.0.0.1',
      port: 0,
      token: 'observe-secret',
      controlToken: 'control-secret',
      stateDirectory: directory,
      provider: controlled,
    })
    const headers = {
      Authorization: 'Bearer control-secret',
      'Content-Type': 'application/json',
    }
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    try {
      const observed = await fetch(
        `${agent.url}/agent/control/v1/sessions/session-1`,
        { headers },
      )
      expect(await observed.json()).toMatchObject({
        permissions: [{ id: 'permission-1', sessionId: 'session-1' }],
      })

      pending = false
      const revokedBody = JSON.stringify({
        commandId: 'revoked-permission',
        expiresAt,
        optionId: 'allow-once',
      })
      const revoked = await fetch(
        `${agent.url}/agent/control/v1/sessions/session-1/permissions/permission-1`,
        { method: 'POST', headers, body: revokedBody },
      )
      expect(revoked.status).toBe(202)
      expect(await revoked.json()).toMatchObject({
        commandId: 'revoked-permission',
        status: 'failed',
      })
      const retried = await fetch(
        `${agent.url}/agent/control/v1/sessions/session-1/permissions/permission-1`,
        { method: 'POST', headers, body: revokedBody },
      )
      expect(await retried.json()).toMatchObject({ status: 'failed' })
      expect(resolveCalls).toBe(0)

      pending = true
      const substituted = await fetch(
        `${agent.url}/agent/control/v1/sessions/session-2/permissions/permission-1`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            commandId: 'cross-session-permission',
            expiresAt,
            optionId: 'allow-once',
          }),
        },
      )
      expect(substituted.status).toBe(202)
      expect(await substituted.json()).toMatchObject({ status: 'failed' })
      expect(resolveCalls).toBe(0)
    } finally {
      await agent.close()
    }
  })

  it('does not attach an observed CLI session to remote control', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-managed-boundary-'))
    cleanup.push(directory)
    const local = new LocalHostAgentProvider(directory, path.join(directory, 'grok'), true)
    await expect(local.remoteSession('observed-cli-session')).rejects.toThrow(/host-managed/i)
    await expect(local.promptRemoteSession(
      'observed-cli-session',
      'do not attach this session',
    )).rejects.toThrow(/host-managed/i)
  })
})
