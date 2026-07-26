import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = path.join(os.tmpdir(), 'grok-ui-e2e')
const grokHome = path.join(fixtureRoot, 'grok-home')
const stateDirectory = path.join(fixtureRoot, 'ui-state')
const workspace = path.join(fixtureRoot, 'secret-client')

await fs.rm(fixtureRoot, { recursive: true, force: true })
await Promise.all([
  fs.mkdir(grokHome, { recursive: true }),
  fs.mkdir(stateDirectory, { recursive: true }),
  fs.mkdir(workspace, { recursive: true }),
])
await fs.writeFile(path.join(fixtureRoot, 'fixture.json'), JSON.stringify({
  fixtureRoot,
  grokHome,
  stateDirectory,
  workspace,
}))

process.env.PORT = '4399'
process.env.HOST = '127.0.0.1'
process.env.GROK_HOME = grokHome
process.env.GROK_UI_STATE_DIR = stateDirectory
process.env.GROK_BIN = path.join(projectRoot, 'scripts', 'fake-grok-e2e.mjs')
process.env.GROK_UI_E2E = '1'

await import('../dist-server/index.js')
