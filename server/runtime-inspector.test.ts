import { describe, expect, it, vi } from 'vitest'
import {
  classifyServices,
  parseLsofPorts,
  parseProcessTable,
  parseSsPorts,
  projectRuntimeSignals,
  RuntimeInspector,
  selectProcessTree,
} from './runtime-inspector.js'
import type { ControlSnapshot, LiveSnapshot, RuntimeRoot } from './types.js'

function liveSnapshot(status = 'completed'): LiveSnapshot {
  return {
    generatedAt: '2026-07-26T12:00:00.000Z',
    connected: true,
    activeCount: 1,
    workingCount: 1,
    attentionCount: 0,
    agents: [{
      id: 'session-1',
      pid: 100,
      title: 'Runtime fixture',
      cwd: '/tmp/runtime-fixture',
      workspace: 'runtime-fixture',
      openedAt: '2026-07-26T11:59:00.000Z',
      updatedAt: '2026-07-26T12:00:00.000Z',
      model: 'grok-code',
      phase: 'tool_execution',
      state: 'working',
      turns: 1,
      toolCalls: 2,
      contextUsage: 0.1,
      currentTool: 'Run Vitest suite',
      contextUsed: 1_000,
      contextSize: 10_000,
      costAmount: 0,
      costCurrency: '',
      costTelemetryAvailable: false,
      feed: [{
        id: 'tool-test',
        type: 'tool',
        title: 'Run Vitest suite',
        text: '',
        status,
        timestamp: '2026-07-26T12:00:00.000Z',
      }, {
        id: 'tool-external',
        type: 'tool',
        title: 'Fetch GitHub issue',
        text: 'raw input is intentionally ignored',
        status: 'completed',
        timestamp: '2026-07-26T12:00:01.000Z',
      }],
    }],
  }
}

function controlSnapshot(): ControlSnapshot {
  return {
    generatedAt: '2026-07-26T12:00:00.000Z',
    connected: true,
    processId: 0,
    starting: false,
    reconnecting: false,
    reconnectAttempt: 0,
    lastDisconnectedAt: '',
    agentName: 'Grok',
    agentVersion: 'test',
    error: '',
    sessions: [],
    workflows: [],
    permissions: [],
  }
}

const processOutput = [
  '  1     0 S 01:00:00 /sbin/launchd',
  '100     1 S    00:12 /usr/local/bin/grok',
  '110   100 R    00:08 /usr/local/bin/node --secret ignored',
  '111   110 S    00:03 /opt/homebrew/bin/postgres',
  '900     1 S    10:00 /usr/bin/unrelated',
].join('\n')

describe('runtime process and port projection', () => {
  it('selects only bounded descendants and exposes executable names without arguments', () => {
    const roots: RuntimeRoot[] = [{
      pid: 100,
      managed: false,
      sessionIds: ['session-1'],
      workspaces: ['/tmp/runtime-fixture'],
    }]
    const selected = selectProcessTree(parseProcessTable(processOutput), roots)

    expect(selected.map((process) => process.pid)).toEqual([100, 110, 111])
    expect(selected[1]).toMatchObject({
      parentPid: 100,
      depth: 1,
      name: 'node',
      state: 'running',
      sessionIds: ['session-1'],
    })
    expect(JSON.stringify(selected)).not.toContain('secret')
    expect(JSON.stringify(selected)).not.toContain('unrelated')
  })

  it('parses lsof and Linux ss listeners only for the selected process set', () => {
    const allowed = new Set([110, 111])
    const lsof = parseLsofPorts([
      'p110',
      'cnode',
      'n127.0.0.1:3000',
      'p111',
      'cpostgres',
      'n*:5432',
      'p900',
      'nuntrusted.example:443',
    ].join('\n'), allowed)
    expect(lsof).toEqual([
      { pid: 110, port: 3000, protocol: 'tcp', bind: 'loopback' },
      { pid: 111, port: 5432, protocol: 'tcp', bind: 'all' },
    ])

    const ss = parseSsPorts([
      'LISTEN 0 511 127.0.0.1:4173 0.0.0.0:* users:(("node",pid=110,fd=20))',
      'LISTEN 0 511 0.0.0.0:9999 0.0.0.0:* users:(("other",pid=900,fd=4))',
    ].join('\n'), allowed)
    expect(ss).toEqual([
      { pid: 110, port: 4173, protocol: 'tcp', bind: 'loopback' },
    ])
  })

  it('classifies database and local development services without probing them', () => {
    const roots: RuntimeRoot[] = [{
      pid: 100,
      managed: false,
      sessionIds: ['session-1'],
      workspaces: ['/tmp/runtime-fixture'],
    }]
    const processes = selectProcessTree(parseProcessTable(processOutput), roots)
    const ports = parseLsofPorts([
      'p110',
      'n127.0.0.1:3000',
      'p111',
      'n*:5432',
    ].join('\n'), new Set([100, 110, 111]))

    expect(classifyServices(processes, ports)).toEqual([
      {
        id: 'service:110:3000',
        pid: 110,
        name: 'Web development server',
        kind: 'dev-server',
        port: 3000,
        bind: 'loopback',
        status: 'listening',
      },
      {
        id: 'service:111:5432',
        pid: 111,
        name: 'PostgreSQL',
        kind: 'database',
        port: 5432,
        bind: 'all',
        status: 'listening',
      },
    ])
  })
})

describe('runtime structured signals', () => {
  it('tracks test status and external tools from safe titles without raw tool input', () => {
    const signals = projectRuntimeSignals(liveSnapshot(), controlSnapshot())

    expect(signals.tests[0]).toMatchObject({
      sessionId: 'session-1',
      title: 'Run Vitest suite',
      framework: 'Vitest',
      status: 'passed',
      incomplete: false,
    })
    expect(signals.externalCalls[0]).toMatchObject({
      sessionId: 'session-1',
      title: 'Fetch GitHub issue',
      category: 'vcs',
      status: 'completed',
    })
    expect(JSON.stringify(signals)).not.toContain('raw input')
  })

  it('joins process, port, service, test, and external-call projections in one snapshot', async () => {
    const runner = {
      run: vi.fn(async (command: string) => command === 'ps'
        ? processOutput
        : [
          'p110',
          'n127.0.0.1:3000',
          'p111',
          'n*:5432',
        ].join('\n')),
    }
    const inspector = new RuntimeInspector(
      runner,
      'darwin',
      2_000,
      () => new Date('2026-07-26T12:00:02.000Z'),
    )
    inspector.update(liveSnapshot(), controlSnapshot())
    await inspector.refresh()
    const snapshot = inspector.snapshot()

    expect(snapshot).toMatchObject({
      available: true,
      partial: false,
    })
    expect(snapshot.processes).toHaveLength(3)
    expect(snapshot.ports).toHaveLength(2)
    expect(snapshot.services.map((service) => service.kind)).toEqual(['dev-server', 'database'])
    expect(snapshot.tests[0].status).toBe('passed')
    expect(snapshot.externalCalls[0].category).toBe('vcs')
    expect(runner.run).toHaveBeenCalledWith('ps', expect.any(Array), 1_500)
    expect(runner.run).toHaveBeenCalledWith('lsof', expect.any(Array), 1_500)
  })

  it('marks a running test interrupted when its live session disappears', async () => {
    const runner = {
      run: vi.fn(async (command: string) => command === 'ps' ? processOutput : ''),
    }
    const inspector = new RuntimeInspector(
      runner,
      'darwin',
      2_000,
      () => new Date('2026-07-26T12:00:02.000Z'),
    )
    inspector.update(liveSnapshot('in_progress'), controlSnapshot())
    await inspector.refresh()
    expect(inspector.snapshot().tests[0].status).toBe('running')

    inspector.update({
      ...liveSnapshot(),
      activeCount: 0,
      workingCount: 0,
      agents: [],
    }, controlSnapshot())
    await inspector.refresh()

    expect(inspector.snapshot().tests[0]).toMatchObject({
      status: 'interrupted',
      incomplete: true,
    })
  })

  it('returns structured signal telemetry while marking OS inspection unavailable on Windows', async () => {
    const runner = { run: vi.fn(async () => '') }
    const inspector = new RuntimeInspector(
      runner,
      'win32',
      2_000,
      () => new Date('2026-07-26T12:00:02.000Z'),
    )
    inspector.update(liveSnapshot(), controlSnapshot())
    await inspector.refresh()

    expect(inspector.snapshot()).toMatchObject({
      available: false,
      partial: true,
      processes: [],
    })
    expect(inspector.snapshot().tests[0].status).toBe('passed')
    expect(runner.run).not.toHaveBeenCalled()
  })
})
