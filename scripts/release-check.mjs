import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const result = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: projectRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})

if (result.status !== 0) {
  console.error(result.stderr || result.stdout)
  process.exit(result.status || 1)
}

const jsonStart = result.stdout.search(/\[\s*\{\s*"id"\s*:/)
if (jsonStart < 0) {
  console.error(result.stdout)
  throw new Error('npm pack did not return a JSON package report.')
}
const report = JSON.parse(result.stdout.slice(jsonStart))[0]
const files = report.files.map((item) => item.path)
const required = [
  'bin/grok-ui.mjs',
  'dist/index.html',
  'dist-server/index.js',
  'dist-server/host-agent-entry.js',
  'package.json',
  'README.md',
  'LICENSE',
]
const forbidden = [
  /^src\//,
  /^server\//,
  /\.test\./,
  /^\.env/,
  /node_modules/,
  /\.grok/,
]

const failures = []
if (manifest.private === true) failures.push('package.json is still marked private')
if (manifest.bin?.['grok-ui'] !== 'bin/grok-ui.mjs') failures.push('grok-ui executable is not configured')
const releaseTag = process.env.RELEASE_TAG || ''
if (releaseTag && releaseTag !== `v${manifest.version}`) {
  failures.push(`release tag ${releaseTag} does not match package version v${manifest.version}`)
}
for (const entry of required) {
  if (!files.includes(entry)) failures.push(`package is missing ${entry}`)
}
for (const entry of files) {
  if (forbidden.some((pattern) => pattern.test(entry))) failures.push(`package includes forbidden file ${entry}`)
}
if (report.unpackedSize > 3_000_000) {
  failures.push(`unpacked package is unexpectedly large (${report.unpackedSize} bytes)`)
}

const sensitive = /\/Users\/|[A-Z]:\\Users\\|Joey Rodriguez|joeyrodriguez/i
for (const file of report.files) {
  if (!/\.(?:html|css|js|mjs|json|md|txt)$/.test(file.path)) continue
  const content = readFileSync(path.join(projectRoot, file.path), 'utf8')
  if (sensitive.test(content)) failures.push(`package contains a machine-specific identity in ${file.path}`)
}

if (failures.length) {
  console.error('\nGROK UI / RELEASE CHECK\n')
  failures.forEach((failure) => console.error(`✕ ${failure}`))
  process.exit(1)
}

console.log('\nGROK UI / RELEASE CHECK\n')
console.log(`✓ Executable          grok-ui → ${manifest.bin['grok-ui']}`)
if (releaseTag) console.log(`✓ Release tag         ${releaseTag} matches package version`)
console.log(`✓ Package contents    ${files.length} files, source and tests excluded`)
console.log(`✓ Unpacked size       ${(report.unpackedSize / 1_000_000).toFixed(2)} MB`)
console.log('✓ Privacy scan        no machine-specific identity in shipped text assets')
console.log(`✓ Artifact            ${report.filename}`)
