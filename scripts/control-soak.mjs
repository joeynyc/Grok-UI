import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GrokController } from '../dist-server/grok-controller.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fakeGrok = path.join(projectRoot, 'scripts', 'fake-grok-e2e.mjs')
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-soak-'))
const previousGrokBin = process.env.GROK_BIN
const controller = new GrokController()

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for soak state.')
    await delay(25)
  }
}

try {
  process.env.GROK_BIN = fakeGrok
  const session = await controller.createSession({
    cwd: workspace,
    prompt: 'Run the long-running cancellation verification',
  })
  await waitFor(() => controller.snapshot().sessions.find((item) => item.id === session.id)
    ?.feed.some((item) => item.title === 'Long-running cancellation fixture'))

  const startedAt = Date.now()
  await delay(75_000)
  const snapshot = controller.snapshot()
  const active = snapshot.sessions.find((item) => item.id === session.id)
  if (!snapshot.connected || active?.state !== 'working' || snapshot.error) {
    throw new Error(`Managed session did not survive the soak: ${JSON.stringify({
      connected: snapshot.connected,
      state: active?.state,
      error: snapshot.error,
    })}`)
  }

  await controller.cancelSession(session.id)
  await waitFor(() => controller.snapshot().sessions.find((item) => item.id === session.id)
    ?.cancellationStatus === 'confirmed')

  console.log('\nGROK UI / CONTROL SOAK\n')
  console.log(`✓ Sustained session   ${Math.round((Date.now() - startedAt) / 1_000)} seconds`)
  console.log('✓ ACP channel         remained connected')
  console.log('✓ Managed turn        remained working')
  console.log('✓ Interruption        confirmed after soak')
} finally {
  await controller.stop()
  if (previousGrokBin === undefined) delete process.env.GROK_BIN
  else process.env.GROK_BIN = previousGrokBin
  await fs.rm(workspace, { recursive: true, force: true })
}
