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
let sequence = 0

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
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'E2E agent received the command.' },
      },
    })
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
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: decision.outcome.outcome === 'selected'
            ? 'Permission approved and command completed.'
            : 'Permission declined.',
        },
      },
    })
    return {
      stopReason: 'end_turn',
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    }
  })
  .onNotification(acp.methods.agent.session.cancel, () => {})

agent.connect(stream)
