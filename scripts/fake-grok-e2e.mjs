#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

const args = process.argv.slice(2)
const readyMarker = path.join(process.env.GROK_HOME || '', 'e2e-cli-ready')
const setupMode = existsSync(readyMarker) ? readFileSync(readyMarker, 'utf8').trim() : 'missing'

if (args[0] === 'version') {
  if (setupMode === 'missing') process.exit(1)
  console.log('Grok Build e2e')
  process.exit(0)
}

if (args[0] === 'models') {
  if (setupMode !== 'ready') process.exit(1)
  console.log('grok-e2e')
  process.exit(0)
}

if (args[0] !== 'agent') {
  console.error('Unsupported e2e command.')
  process.exit(1)
}

const sessions = new Set()
const cancelledSessions = new Set()
const cancelWaiters = new Map()
const ignoredCancellationSessions = new Set()
let sequence = 0

function promptText(prompt) {
  return prompt
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function waitForCancellation(sessionId) {
  if (cancelledSessions.has(sessionId)) return Promise.resolve()
  return new Promise((resolve) => cancelWaiters.set(sessionId, resolve))
}

async function notifyWorkflow(client, sessionId, status, overrides = {}) {
  const completed = status === 'completed'
  const failed = status === 'failed'
  await client.notify('x.ai/session_notification', {
    sessionId,
    update: {
      sessionUpdate: 'workflow_updated',
      run_id: 'workflow-run-1',
      display_name: 'release-check',
      objective: 'Ship a verified release across every implementation lane.',
      foreground: false,
      status,
      phases: [
        { id: 'plan', name: 'Plan release', status: 'completed' },
        { id: 'build', name: 'Build artifact', status: completed ? 'completed' : 'completed' },
        { id: 'verify', name: 'Verify release', status: completed ? 'completed' : failed ? 'failed' : 'in_progress' },
      ],
      current_phase: 'verify',
      agent_budget: 8,
      agents_used: completed ? 5 : 4,
      agents_reserved: 0,
      agent_usage_incomplete: false,
      active_agents: status === 'running' ? 1 : 0,
      current_agent_label: status === 'running' ? 'Verifier' : '',
      agents: [
        {
          agent_id: 'builder',
          label: 'Builder',
          state: 'completed',
          detail: 'Artifact assembled',
          phase: 'build',
          model: 'grok-code-fast-1',
          tokens_used: 4_200,
          duration_ms: 36_000,
        },
        {
          agent_id: 'verifier',
          label: 'Verifier',
          state: completed ? 'completed' : failed ? 'failed' : 'running',
          detail: completed ? 'Release checks passed' : failed ? 'Fixture check failed' : 'Re-running release checks',
          phase: 'verify',
          model: 'grok-code-fast-1',
          tokens_used: completed ? 4_900 : failed ? 2_200 : 3_000,
          duration_ms: completed ? 31_000 : failed ? 18_000 : 22_000,
        },
      ],
      elapsed_ms: completed ? 78_000 : failed ? 58_000 : 64_000,
      last_event: completed ? 'workflow_completed' : failed ? 'workflow_failed' : 'workflow_resumed',
      last_event_detail: completed
        ? 'All release verification lanes passed.'
        : failed
          ? 'Verification lane reported a recoverable failure.'
          : 'Failed workflow resumed from the verification phase.',
      last_event_timestamp: new Date().toISOString(),
      result_summary: completed ? 'Release verified and ready to ship.' : '',
      ...overrides,
    },
  })
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
)

const agent = acp.agent({ name: 'grok-e2e' })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true },
    agentInfo: {
      name: 'grok-e2e',
      title: 'Grok E2E Agent',
      version: '0.0.1',
    },
  }))
  .onRequest(acp.methods.agent.session.new, () => {
    sequence += 1
    const sessionId = `managed-e2e-${sequence}`
    sessions.add(sessionId)
    return { sessionId }
  })
  .onRequest(acp.methods.agent.session.load, ({ params }) => {
    sessions.add(params.sessionId)
    return {}
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    if (!sessions.has(params.sessionId)) throw new Error('Unknown e2e session.')
    const instruction = promptText(params.prompt)
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'E2E agent received the command.' },
      },
    })
    if (instruction.includes('Start workflow fixture')) {
      await notifyWorkflow(client, params.sessionId, 'failed')
      return {
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 6, totalTokens: 16 },
      }
    }
    if (instruction.includes('Start scaled workflow fixture')) {
      const agents = Array.from({ length: 30 }, (_, index) => ({
        agent_id: `scale-agent-${index + 1}`,
        label: `Scale agent ${index + 1}`,
        state: index < 6 ? 'running' : 'completed',
        detail: index < 6 ? 'Processing a live shard' : 'Shard complete',
        phase: index < 6 ? 'synthesize' : 'research',
        model: index % 2 ? 'grok-4-fast' : 'grok-4',
        tokens_used: (index + 1) * 125,
        duration_ms: (index + 1) * 900,
      }))
      await notifyWorkflow(client, params.sessionId, 'running', {
        run_id: 'workflow-scale-1',
        display_name: 'scale-check',
        objective: 'Coordinate a large multi-agent research field.',
        phases: [
          { id: 'research', name: 'Research shards', status: 'completed' },
          { id: 'synthesize', name: 'Synthesize findings', status: 'in_progress' },
          { id: 'review', name: 'Review result', status: 'pending' },
        ],
        current_phase: 'synthesize',
        agent_budget: 1024,
        agents_used: 30,
        agents_remaining: 994,
        active_agents: 6,
        current_agent_label: 'Scale agent 1',
        agents,
        elapsed_ms: 45_000,
        last_event: 'workflow_progress',
        last_event_detail: 'Six synthesis agents are processing live shards.',
      })
      return {
        stopReason: 'end_turn',
        usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
      }
    }
    if (instruction === '/workflow resume release-check') {
      await notifyWorkflow(client, params.sessionId, 'running')
      await notifyWorkflow(client, params.sessionId, 'completed')
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Workflow release-check resumed and completed.' },
        },
      })
      return {
        stopReason: 'end_turn',
        usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
      }
    }
    if (instruction.includes('long-running cancellation') || instruction.includes('ignored cancellation')) {
      if (instruction.includes('ignored cancellation')) ignoredCancellationSessions.add(params.sessionId)
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'long-running-tool',
          title: 'Long-running cancellation fixture',
          kind: 'execute',
          status: 'in_progress',
          locations: [],
          rawInput: {},
        },
      })
      await waitForCancellation(params.sessionId)
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'long-running-tool',
          title: 'Long-running cancellation fixture',
          status: 'failed',
        },
      })
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Cancellation confirmed. No further tool work executed.' },
        },
      })
      return { stopReason: 'cancelled' }
    }
    const decision = await client.request(acp.methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: 'e2e-tool',
        title: 'Write the verified fixture',
        kind: 'edit',
        status: 'pending',
        locations: [],
        rawInput: {},
      },
      options: [
        { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    })
    const cancelled = decision.outcome.outcome === 'cancelled'
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'e2e-tool',
        title: 'Write the verified fixture',
        status: cancelled ? 'failed' : 'completed',
      },
    })
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: decision.outcome.outcome === 'selected'
            ? 'Permission approved and command completed.'
            : cancelled
              ? 'Cancellation confirmed while permission was pending.'
              : 'Permission declined.',
        },
      },
    })
    if (cancelled) return { stopReason: 'cancelled' }
    return {
      stopReason: 'end_turn',
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    }
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    cancelledSessions.add(params.sessionId)
    if (ignoredCancellationSessions.has(params.sessionId)) return
    cancelWaiters.get(params.sessionId)?.()
    cancelWaiters.delete(params.sessionId)
  })

agent.connect(stream)
