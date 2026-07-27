#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))

function usage() {
  console.log(`
Grok UI ${manifest.version}

Usage:
  grok-ui [start] [options]
  grok-ui agent [options]
  grok-ui doctor

Options:
  --port <number>       Local port (default: 4310)
  --host <address>      Bind address (default: 127.0.0.1)
  --grok-home <path>    Override the Grok state directory
  --state-dir <path>    Override Grok UI's private state directory
  --no-open             Do not open the browser automatically
  --help                Show this help
  --version             Print the installed version

Remote binds require GROK_UI_TOKEN. Run \`grok-ui doctor\` to check the
local Node.js, Grok CLI, authentication, and state prerequisites.

The read-only host agent uses port 4311 by default and always requires
GROK_UI_AGENT_TOKEN, including on loopback.
`.trim())
}

function takeValue(args, index, flag) {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`)
  return value
}

function openBrowser(url) {
  const command = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  const child = spawn(command[0], command[1], {
    detached: true,
    stdio: 'ignore',
  })
  child.on('error', () => {
    // The URL is already printed by the server for manual opening.
  })
  child.unref()
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'start'

  if (command === 'doctor') {
    if (args.length) throw new Error('The doctor command does not accept additional options.')
    await import('../scripts/doctor.mjs')
    return
  }
  if (command !== 'start' && command !== 'agent') throw new Error(`Unknown command: ${command}`)

  const agentMode = command === 'agent'
  let open = !agentMode
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === '--help' || flag === '-h') {
      usage()
      return
    }
    if (flag === '--version' || flag === '-v') {
      console.log(manifest.version)
      return
    }
    if (flag === '--no-open') {
      open = false
      continue
    }
    if (flag === '--port') {
      const value = takeValue(args, index, flag)
      const port = Number(value)
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error('--port must be an integer between 1 and 65535.')
      }
      if (agentMode) process.env.GROK_UI_AGENT_PORT = String(port)
      else process.env.PORT = String(port)
      index += 1
      continue
    }
    if (flag === '--host') {
      if (agentMode) process.env.GROK_UI_AGENT_HOST = takeValue(args, index, flag)
      else process.env.HOST = takeValue(args, index, flag)
      index += 1
      continue
    }
    if (flag === '--grok-home') {
      process.env.GROK_HOME = path.resolve(takeValue(args, index, flag))
      index += 1
      continue
    }
    if (flag === '--state-dir') {
      process.env.GROK_UI_STATE_DIR = path.resolve(takeValue(args, index, flag))
      index += 1
      continue
    }
    throw new Error(`Unknown option: ${flag}`)
  }

  if (agentMode) {
    await import('../dist-server/host-agent-entry.js')
    return
  }
  const runtime = await import('../dist-server/index.js')
  if (open) openBrowser(runtime.serverUrl)
}

main().catch((error) => {
  console.error(`\nGrok UI could not start: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
