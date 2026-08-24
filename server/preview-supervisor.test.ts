import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PREVIEW_BIND_HOST,
  PREVIEW_PUBLIC_HOST,
  PreviewSupervisor,
  previewLoopbackUrl,
  type PreviewSnapshot,
} from './preview-supervisor.js'

const directories: string[] = []
const supervisors: PreviewSupervisor[] = []

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.close()))
  await Promise.all(directories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ))
})

async function temporary(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  directories.push(directory)
  return directory
}

async function waitFor(
  supervisor: PreviewSupervisor,
  sessionId: string,
  cwd: string,
  status: PreviewSnapshot['status'],
): Promise<PreviewSnapshot> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const snapshot = await supervisor.inspect(sessionId, cwd)
    if (snapshot.status === status) return snapshot
    if (snapshot.status === 'failed' && status !== 'failed') throw new Error(snapshot.error)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Preview did not reach ${status}.`)
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntilGone(pid: number, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(`Process ${pid} was still alive after ${timeoutMs}ms.`)
}

async function waitForPid(file: string): Promise<number> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const pid = Number((await fs.readFile(file, 'utf8')).trim())
      if (pid > 0) return pid
    } catch {
      // The child writes this after spawn.
    }
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error('Preview pid file was not written.')
}

const hangServer = `
  import { writeFileSync } from 'node:fs'
  writeFileSync('preview.pid', String(process.pid))
  setInterval(() => {}, 1 << 30)
`

const readyServer = `
  import http from 'node:http'
  import { writeFileSync } from 'node:fs'
  writeFileSync('preview.pid', String(process.pid))
  const host = process.env.HOST
  const port = Number(process.env.PORT)
  http.createServer((_request, response) => {
    response.end('preview-ready')
  }).listen(port, host, () => console.log('preview listening on ' + host + ':' + port))
`

describe('PreviewSupervisor', () => {
  it('detects framework-aware loopback commands without starting code', async () => {
    const cwd = await temporary('grok-ui-preview-detect-')
    await Promise.all([
      fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({
        scripts: { dev: 'vite' },
        devDependencies: { vite: '^8.0.0' },
      })),
      fs.writeFile(path.join(cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n'),
    ])
    const supervisor = new PreviewSupervisor()
    supervisors.push(supervisor)

    const snapshot = await supervisor.inspect('preview-detect', cwd)

    expect(snapshot).toMatchObject({
      available: true,
      status: 'idle',
      command: 'pnpm',
      port: 0,
      url: '',
    })
    expect(snapshot.displayCommand).toContain(`--host ${PREVIEW_BIND_HOST} --port <port>`)
  })

  it('labels generic scripts as a best-effort host bind', async () => {
    const cwd = await temporary('grok-ui-preview-generic-')
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({
      scripts: { start: 'node server.js' },
    }))
    const supervisor = new PreviewSupervisor()
    supervisors.push(supervisor)

    const snapshot = await supervisor.inspect('preview-generic', cwd)

    expect(snapshot.available).toBe(true)
    expect(snapshot.displayCommand).toContain('best-effort')
    expect(snapshot.displayCommand).toContain(`HOST=${PREVIEW_BIND_HOST}`)
  })

  it('starts, observes, and stops a session-scoped loopback preview', async () => {
    const cwd = await temporary('grok-ui-preview-run-')
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({
      scripts: { dev: 'node preview-server.mjs' },
    }))
    await fs.writeFile(path.join(cwd, 'preview-server.mjs'), readyServer)
    const supervisor = new PreviewSupervisor(8_000, 50)
    supervisors.push(supervisor)

    const starting = await supervisor.start('preview-run', cwd)
    expect(starting).toMatchObject({
      available: true,
      status: 'starting',
      command: 'npm',
    })
    expect(starting.url).toBe(`http://${PREVIEW_PUBLIC_HOST}:${starting.port}`)

    const running = await waitFor(supervisor, 'preview-run', cwd, 'running')
    expect(await (await fetch(previewLoopbackUrl(running.port))).text()).toBe('preview-ready')
    expect(running.logs.join('\n')).toContain(`preview listening on ${PREVIEW_BIND_HOST}`)

    const stopped = await supervisor.stop('preview-run')
    expect(stopped.status).toBe('stopped')
    await expect(fetch(previewLoopbackUrl(running.port))).rejects.toThrow()
  })

  it('reaps a detached group after a readiness timeout', { timeout: 15_000 }, async () => {
    const cwd = await temporary('grok-ui-preview-timeout-')
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({
      scripts: { dev: 'node preview-server.mjs' },
    }))
    await fs.writeFile(path.join(cwd, 'preview-server.mjs'), hangServer)
    const supervisor = new PreviewSupervisor(2_000, 50, 150)
    supervisors.push(supervisor)

    await supervisor.start('preview-timeout', cwd)
    const pid = await waitForPid(path.join(cwd, 'preview.pid'))
    expect(processAlive(pid)).toBe(true)

    const failed = await waitFor(supervisor, 'preview-timeout', cwd, 'failed')
    expect(failed.error).toContain('did not respond')
    await waitUntilGone(pid)
  })

  it('serializes overlapping starts onto one child', async () => {
    const cwd = await temporary('grok-ui-preview-concurrent-')
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({
      scripts: { dev: 'node preview-server.mjs' },
    }))
    await fs.writeFile(path.join(cwd, 'preview-server.mjs'), readyServer)
    const supervisor = new PreviewSupervisor(8_000, 50)
    supervisors.push(supervisor)

    const [first, second] = await Promise.all([
      supervisor.start('preview-concurrent', cwd),
      supervisor.start('preview-concurrent', cwd),
    ])

    expect(first.port).toBe(second.port)
    expect(first.url).toBe(second.url)
    const running = await waitFor(supervisor, 'preview-concurrent', cwd, 'running')
    expect(await (await fetch(previewLoopbackUrl(running.port))).text()).toBe('preview-ready')
  })

  it('restarts after a timeout without leaving the previous group alive', { timeout: 15_000 }, async () => {
    const cwd = await temporary('grok-ui-preview-restart-')
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({
      scripts: { dev: 'node preview-server.mjs' },
    }))
    await fs.writeFile(path.join(cwd, 'preview-server.mjs'), hangServer)
    const supervisor = new PreviewSupervisor(2_000, 50, 150)
    supervisors.push(supervisor)

    await supervisor.start('preview-restart', cwd)
    const hungPid = await waitForPid(path.join(cwd, 'preview.pid'))
    await waitFor(supervisor, 'preview-restart', cwd, 'failed')
    await waitUntilGone(hungPid)

    await fs.writeFile(path.join(cwd, 'preview-server.mjs'), readyServer)
    await supervisor.start('preview-restart', cwd)
    const running = await waitFor(supervisor, 'preview-restart', cwd, 'running')
    const readyPid = await waitForPid(path.join(cwd, 'preview.pid'))
    expect(readyPid).not.toBe(hungPid)
    expect(await (await fetch(previewLoopbackUrl(running.port))).text()).toBe('preview-ready')
  })

  it('does not invent a command for workspaces without a supported script', async () => {
    const cwd = await temporary('grok-ui-preview-missing-')
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({
      scripts: { build: 'vite build' },
    }))
    const supervisor = new PreviewSupervisor()
    supervisors.push(supervisor)

    const snapshot = await supervisor.inspect('preview-missing', cwd)

    expect(snapshot.available).toBe(false)
    expect(snapshot.error).toContain('dev or start script')
    await expect(supervisor.start('preview-missing', cwd)).rejects.toThrow('dev or start script')
  })

  it('strips cookies before they reach the preview process', async () => {
    const cwd = await temporary('grok-ui-preview-cookie-')
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({
      scripts: { dev: 'node preview-server.mjs' },
    }))
    await fs.writeFile(path.join(cwd, 'preview-server.mjs'), `
      import http from 'node:http'
      const host = process.env.HOST
      const port = Number(process.env.PORT)
      http.createServer((request, response) => {
        response.end(request.headers.cookie || '')
      }).listen(port, host)
    `)
    const supervisor = new PreviewSupervisor(8_000, 50)
    supervisors.push(supervisor)

    await supervisor.start('preview-cookie', cwd)
    const running = await waitFor(supervisor, 'preview-cookie', cwd, 'running')
    const echoed = await (await fetch(previewLoopbackUrl(running.port), {
      headers: { Cookie: 'grok_ui_session=should-not-leak' },
    })).text()
    expect(echoed).toBe('')
  })
})
