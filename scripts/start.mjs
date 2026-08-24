import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientEntry = path.join(projectRoot, 'dist', 'index.html')
const serverEntry = path.join(projectRoot, 'dist-server', 'index.js')

if (!existsSync(clientEntry) || !existsSync(serverEntry)) {
  console.log('Production build not found. Building Grok UI…')
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const build = spawnSync(npm, ['run', 'build'], {
    cwd: projectRoot,
    stdio: 'inherit',
  })
  if (build.status !== 0) process.exit(build.status || 1)
}

await import(pathToFileURL(serverEntry).href)
