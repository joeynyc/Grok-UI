import { spawn, spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'))
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-package-'))
const packDirectory = path.join(temporaryRoot, 'pack')
const installDirectory = path.join(temporaryRoot, 'install')
const grokHome = path.join(temporaryRoot, 'grok-home')
const stateDirectory = path.join(temporaryRoot, 'state')
const fakeGrok = path.join(temporaryRoot, 'grok')
const readyMarker = path.join(grokHome, 'package-cli-ready')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} exited with ${result.status}`)
  }
  return result.stdout.trim()
}

function packReport(output) {
  const jsonStart = output.search(/\[\s*\{\s*"id"\s*:/)
  if (jsonStart < 0) throw new Error('npm pack did not return a JSON package report.')
  return JSON.parse(output.slice(jsonStart))[0]
}

async function availablePort() {
  const reservation = createServer()
  await new Promise((resolve, reject) => {
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', resolve)
  })
  const address = reservation.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve) => reservation.close(resolve))
  return port
}

async function waitForHealth(url, child, output) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`packaged server exited early\n${output.join('')}`)
    try {
      const response = await fetch(url)
      if (response.ok) return response.json()
    } catch {
      // The packaged server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`packaged server did not become healthy\n${output.join('')}`)
}

let child
try {
  await Promise.all([
    fs.mkdir(packDirectory),
    fs.mkdir(installDirectory),
    fs.mkdir(grokHome),
    fs.mkdir(stateDirectory),
  ])
  await fs.writeFile(path.join(installDirectory, 'package.json'), '{"private":true,"type":"module"}\n')
  await fs.writeFile(fakeGrok, `#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
const marker = path.join(process.env.GROK_HOME || '', 'package-cli-ready')
const mode = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : 'missing'
if (process.argv[2] === 'version' && mode !== 'missing') console.log('Grok Build package-smoke')
else if (process.argv[2] === 'models' && mode === 'ready') console.log('grok-package-smoke')
else process.exit(1)
`)
  await fs.chmod(fakeGrok, 0o755)

  const packOutput = run(
    npm,
    ['pack', '--json', '--ignore-scripts', '--pack-destination', packDirectory],
    projectRoot,
  )
  const packed = packReport(packOutput)
  const tarball = path.join(packDirectory, packed.filename)
  run(npm, ['install', '--no-audit', '--no-fund', tarball], installDirectory)

  const executable = process.platform === 'win32'
    ? path.join(installDirectory, 'node_modules', '.bin', 'grok-ui.cmd')
    : path.join(installDirectory, 'node_modules', '.bin', 'grok-ui')
  const version = run(executable, ['--version'], installDirectory)
  if (version !== manifest.version) throw new Error(`expected CLI ${manifest.version}, received ${version}`)
  const help = run(executable, ['--help'], installDirectory)
  if (!help.includes('grok-ui doctor')) throw new Error('CLI help is missing the doctor workflow')
  const doctor = spawnSync(executable, ['doctor'], {
    cwd: installDirectory,
    env: {
      ...process.env,
      GROK_BIN: 'grok-ui-smoke-missing-cli',
      GROK_HOME: grokHome,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (
    doctor.status === 0
    || !doctor.stdout.includes('Grok CLI')
    || doctor.stdout.includes(temporaryRoot)
  ) {
    throw new Error('packaged doctor did not return a safe actionable failure')
  }
  const remoteEnvironment = { ...process.env }
  delete remoteEnvironment.GROK_UI_TOKEN
  const remoteBind = spawnSync(executable, ['--no-open', '--host', '0.0.0.0'], {
    cwd: installDirectory,
    env: remoteEnvironment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (remoteBind.status === 0 || !remoteBind.stderr.includes('GROK_UI_TOKEN')) {
    throw new Error('packaged CLI allowed a remote bind without GROK_UI_TOKEN')
  }

  const port = await availablePort()
  const output = []
  child = spawn(executable, [
    '--no-open',
    '--port', String(port),
    '--grok-home', grokHome,
    '--state-dir', stateDirectory,
  ], {
    cwd: installDirectory,
    env: { ...process.env, GROK_BIN: fakeGrok },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => output.push(chunk.toString()))
  child.stderr.on('data', (chunk) => output.push(chunk.toString()))

  const healthUrl = `http://127.0.0.1:${port}/api/health`
  const health = await waitForHealth(healthUrl, child, output)
  if (!health.ok || health.version !== manifest.version) {
    throw new Error(`unexpected health response: ${JSON.stringify(health)}`)
  }
  const healthHeaders = await fetch(healthUrl)
  if (
    healthHeaders.headers.get('x-frame-options') !== 'DENY'
    || !healthHeaders.headers.get('content-security-policy')?.includes("default-src 'self'")
  ) {
    throw new Error('packaged server is missing required browser security headers')
  }
  const setupResponse = await fetch(`http://127.0.0.1:${port}/api/setup`)
  const setup = await setupResponse.json()
  if (
    !setupResponse.ok
    || setup.ready
    || setup.checks?.find((check) => check.id === 'cli')?.state !== 'action'
  ) {
    throw new Error(`unexpected setup diagnostics: ${JSON.stringify(setup)}`)
  }
  await fs.writeFile(readyMarker, 'unauthenticated\n')
  const loggedOutResponse = await fetch(`http://127.0.0.1:${port}/api/setup?refresh=1`)
  const loggedOutSetup = await loggedOutResponse.json()
  if (
    !loggedOutResponse.ok
    || loggedOutSetup.ready
    || loggedOutSetup.checks?.find((check) => check.id === 'cli')?.state !== 'ready'
    || loggedOutSetup.checks?.find((check) => check.id === 'auth')?.state !== 'action'
  ) {
    throw new Error(`packaged onboarding did not identify logged-out CLI: ${JSON.stringify(loggedOutSetup)}`)
  }

  await fs.writeFile(readyMarker, 'ready\n')
  const readyResponse = await fetch(`http://127.0.0.1:${port}/api/setup?refresh=1`)
  const readySetup = await readyResponse.json()
  if (
    !readyResponse.ok
    || !readySetup.ready
    || readySetup.checks?.some((check) => check.id !== 'state' && check.state !== 'ready')
  ) {
    throw new Error(`packaged onboarding did not reach ready: ${JSON.stringify(readySetup)}`)
  }

  const liveSessionId = 'package-smoke-live'
  const openedAt = new Date().toISOString()
  await fs.writeFile(path.join(grokHome, 'active_sessions.json'), JSON.stringify([{
    session_id: liveSessionId,
    pid: process.pid,
    cwd: installDirectory,
    opened_at: openedAt,
  }]))
  const liveDeadline = Date.now() + 8_000
  let live
  while (Date.now() < liveDeadline) {
    const response = await fetch(`http://127.0.0.1:${port}/api/live`)
    live = await response.json()
    if (live.activeCount === 1 && live.agents?.[0]?.id === liveSessionId) break
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  if (live?.activeCount !== 1 || live.agents?.[0]?.id !== liveSessionId) {
    throw new Error(`packaged server did not discover a newly registered session: ${JSON.stringify(live)}`)
  }

  console.log('\nGROK UI / PACKAGE SMOKE\n')
  console.log(`✓ Packed artifact     ${packed.filename}`)
  console.log(`✓ Isolated install    production dependencies installed`)
  console.log(`✓ Executable          help, version, and doctor commands passed`)
  console.log(`✓ Remote safety       tokenless non-loopback bind rejected`)
  console.log(`✓ Production server   health check passed on ${process.platform}`)
  console.log(`✓ Browser security    CSP and frame protection headers confirmed`)
  console.log(`✓ First-run failure   missing CLI returned actionable diagnostics`)
  console.log(`✓ First-run logged out installed CLI requested account authentication`)
  console.log(`✓ First-run ready     CLI and account checks transitioned to ready`)
  console.log(`✓ Live registration   new CLI session discovered by the packaged server`)
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  await fs.rm(temporaryRoot, { recursive: true, force: true })
}
