import { startHostAgent } from './host-agent.js'

const host = process.env.GROK_UI_AGENT_HOST || '127.0.0.1'
const port = Number(process.env.GROK_UI_AGENT_PORT || 4311)
const token = process.env.GROK_UI_AGENT_TOKEN || ''
const controlToken = process.env.GROK_UI_AGENT_CONTROL_TOKEN || ''

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('GROK_UI_AGENT_PORT must be an integer between 1 and 65535.')
}

const agent = await startHostAgent({ host, port, token, controlToken })
console.log(`Grok UI host agent → ${agent.url}`)
console.log('Read-only fleet protocol enabled')
console.log(`Secure remote sessions ${controlToken ? 'enabled' : 'disabled'}`)

async function shutdown(): Promise<void> {
  await agent.close()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
