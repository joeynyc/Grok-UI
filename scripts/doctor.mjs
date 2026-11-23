import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function runDoctor(launchCommand = 'npm start') {
  const checks = []

  function check(label, ok, detail, required = true) {
    checks.push({ label, ok, detail, required })
  }

  const nodeMajor = Number(process.versions.node.split('.')[0])
  check('Node.js', nodeMajor >= 22, `v${process.versions.node} ${nodeMajor >= 22 ? 'meets the v22+ requirement' : 'is too old'}`)

  const grokBin = process.env.GROK_BIN || 'grok'
  const version = spawnSync(grokBin, ['version'], {
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const grokVersion = (version.stdout || version.stderr || '').trim().split('\n')[0]
  check('Grok CLI', version.status === 0, version.status === 0 ? grokVersion || 'installed' : 'not found or not executable')

  if (version.status === 0) {
    const models = spawnSync(grokBin, ['models'], {
      encoding: 'utf8',
      timeout: 12_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    check(
      'Grok authentication',
      models.status === 0,
      models.status === 0 ? 'model access confirmed' : 'run `grok login`, then retry',
    )
  } else {
    check('Grok authentication', false, 'cannot check until the Grok CLI is available')
  }

  const grokHome = path.resolve(process.env.GROK_HOME || path.join(os.homedir(), '.grok'))
  check('Local Grok state', existsSync(grokHome), existsSync(grokHome) ? 'state directory detected' : 'will be created by the first Grok session', false)

  console.log('\nGROK UI / PREFLIGHT\n')
  for (const item of checks) {
    const mark = item.ok ? '✓' : item.required ? '✕' : '○'
    console.log(`${mark} ${item.label.padEnd(20)} ${item.detail}`)
  }

  const blockers = checks.filter((item) => item.required && !item.ok)
  if (blockers.length) {
    console.log(`\n${blockers.length} blocking check${blockers.length === 1 ? '' : 's'} must be resolved before launch.\n`)
    process.exitCode = 1
  } else {
    console.log(`\nReady. Run \`${launchCommand}\` and open the localhost URL printed by the server.\n`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDoctor()
}
