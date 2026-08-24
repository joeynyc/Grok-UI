import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  MAX_REMOTE_COMMAND_TTL_MS,
  RemoteCommandStore,
  payloadFingerprint,
} from './remote-command-store.js'

const cleanup: string[] = []
afterEach(async () => Promise.all(cleanup.splice(0).map((item) => fs.rm(item, { recursive: true, force: true }))))

async function store(): Promise<{ store: RemoteCommandStore, dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-commands-'))
  cleanup.push(dir)
  return { store: new RemoteCommandStore(path.join(dir, 'private')), dir }
}
const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()
const request = (commandId = 'command-1', payload: unknown = { prompt: 'private prompt' }) => ({ commandId, kind: 'message', target: 'session-1', actorFingerprint: 'actor-sha256', expiresAt, payload })

async function runRacer(
  stateDirectory: string,
  sideEffectFile: string,
  raceExpiresAt: string,
): Promise<unknown> {
  const moduleUrl = pathToFileURL(path.resolve('server/remote-command-store.ts')).href
  const script = `
    import { appendFile } from 'node:fs/promises'
    const { RemoteCommandStore } = await import(process.env.REMOTE_COMMAND_MODULE_URL)
    const store = new RemoteCommandStore(process.env.REMOTE_COMMAND_STATE_DIR)
    const result = await store.execute({
      commandId: 'cross-process-command',
      kind: 'message',
      target: 'session-1',
      actorFingerprint: 'actor-sha256',
      expiresAt: process.env.REMOTE_COMMAND_EXPIRES_AT,
      payload: { prompt: 'execute once across processes' },
    }, async () => {
      await appendFile(process.env.REMOTE_COMMAND_SIDE_EFFECT, process.pid + '\\n')
      await new Promise((resolve) => setTimeout(resolve, 100))
      return { acceptedBy: process.pid }
    })
    process.stdout.write(JSON.stringify(result))
  `
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      script,
    ], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        REMOTE_COMMAND_MODULE_URL: moduleUrl,
        REMOTE_COMMAND_STATE_DIR: stateDirectory,
        REMOTE_COMMAND_SIDE_EFFECT: sideEffectFile,
        REMOTE_COMMAND_EXPIRES_AT: raceExpiresAt,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Remote command racer exited ${code}: ${stderr}`))
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch {
        reject(new Error(`Remote command racer returned invalid JSON: ${stdout}\n${stderr}`))
      }
    })
  })
}

describe('RemoteCommandStore', () => {
  it('executes once, returns its stored result, and never writes payload content', async () => {
    const fixture = await store(); let calls = 0
    expect(await fixture.store.execute(request(), async () => ({ ok: ++calls }))).toEqual({ outcome: 'completed', result: { ok: 1 } })
    expect(await fixture.store.execute(request('command-1', { prompt: 'private prompt' }), async () => ({ ok: ++calls }))).toEqual({ outcome: 'completed', result: { ok: 1 } })
    expect(calls).toBe(1)
    const file = path.join(fixture.dir, 'private', 'remote-commands.json')
    const serialized = await fs.readFile(file, 'utf8')
    expect(serialized).not.toContain('private prompt')
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700)
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  })

  it('deduplicates concurrent executions and rejects a reused ID for another command', async () => {
    const fixture = await store(); let calls = 0; let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = fixture.store.execute(request(), async () => { calls++; await gate; return 'done' })
    const second = fixture.store.execute(request(), async () => { calls++; return 'wrong' })
    release()
    const results = await Promise.all([first, second])
    expect(results[0]).toEqual(results[1])
    expect(results[0]).toMatchObject({ outcome: 'completed' })
    expect(calls).toBe(1)
    await expect(fixture.store.execute(request('command-1', { prompt: 'changed' }), async () => null)).rejects.toThrow('different command')
    await expect(fixture.store.execute({
      ...request(),
      kind: 'interrupt',
    }, async () => null)).rejects.toThrow('different command')
  })

  it('returns a completed result after restart without replaying a lost acknowledgement', async () => {
    const fixture = await store()
    let calls = 0
    expect(await fixture.store.execute(request('lost-ack'), async () => ({
      applied: ++calls,
    }))).toEqual({ outcome: 'completed', result: { applied: 1 } })

    const restarted = new RemoteCommandStore(path.join(fixture.dir, 'private'))
    expect(await restarted.execute(request('lost-ack'), async () => ({
      applied: ++calls,
    }))).toEqual({ outcome: 'completed', result: { applied: 1 } })
    expect(calls).toBe(1)
  })

  it('serializes two independent host-agent processes against one durable store', async () => {
    const fixture = await store()
    const privateDirectory = path.join(fixture.dir, 'private')
    const sideEffectFile = path.join(fixture.dir, 'side-effects.log')
    const raceExpiresAt = new Date(Date.now() + 60_000).toISOString()
    const results = await Promise.all(Array.from(
      { length: 6 },
      () => runRacer(privateDirectory, sideEffectFile, raceExpiresAt),
    ))

    expect(results).toHaveLength(6)
    results.forEach((result) => {
      expect(result).toEqual(results[0])
      expect(result).toMatchObject({ outcome: 'completed' })
    })
    const effects = (await fs.readFile(sideEffectFile, 'utf8')).trim().split('\n')
    expect(effects).toHaveLength(1)
  }, 15_000)

  it('marks interrupted accepted or executing commands unknown after reload', async () => {
    const fixture = await store()
    const privateDir = path.join(fixture.dir, 'private')
    await fs.mkdir(privateDir, { recursive: true })
    await fs.writeFile(path.join(privateDir, 'remote-commands.json'), JSON.stringify({ version: 1, commands: [{ commandId: 'old', kind: 'message', target: 'session-1', actorFingerprint: 'actor-sha256', payloadFingerprint: payloadFingerprint({ a: 1 }), acceptedAt: '2026-01-01T00:00:00.000Z', expiresAt, updatedAt: '2026-01-01T00:00:00.000Z', outcome: 'executing' }], audit: [] }))
    let calls = 0
    await expect(fixture.store.execute(request('old', { a: 1 }), async () => ++calls)).resolves.toEqual({ outcome: 'unknown' })
    expect(calls).toBe(0)
  })

  it('recovers a dead process lock while preserving an ambiguous command as unknown', async () => {
    const fixture = await store()
    const privateDir = path.join(fixture.dir, 'private')
    await fs.mkdir(privateDir, { recursive: true })
    await fs.writeFile(path.join(privateDir, '.remote-commands.lock'), JSON.stringify({
      token: 'abandoned-lock',
      pid: 2_147_483_647,
      createdAt: '2026-01-01T00:00:00.000Z',
    }))
    await fs.writeFile(path.join(privateDir, 'remote-commands.json'), JSON.stringify({
      version: 1,
      commands: [{
        commandId: 'orphaned-command',
        kind: 'message',
        target: 'session-1',
        actorFingerprint: 'actor-sha256',
        payloadFingerprint: payloadFingerprint({ prompt: 'private prompt' }),
        acceptedAt: '2026-01-01T00:00:00.000Z',
        expiresAt,
        updatedAt: '2026-01-01T00:00:00.000Z',
        outcome: 'executing',
      }],
      audit: [],
    }))
    let calls = 0
    await expect(fixture.store.execute(
      request('orphaned-command'),
      async () => ++calls,
    )).resolves.toEqual({ outcome: 'unknown' })
    expect(calls).toBe(0)
    await expect(fs.access(path.join(privateDir, '.remote-commands.lock'))).rejects.toThrow()
  })

  it('validates command IDs and records failures without payload in the audit', async () => {
    const fixture = await store()
    await expect(fixture.store.execute(request('../bad'), async () => null)).rejects.toThrow('Invalid commandId')
    await expect(fixture.store.execute(request('failure', { body: 'do not retain' }), async () => { throw new Error('secret provider context') })).resolves.toEqual({ outcome: 'failed', error: 'Remote command failed on the host.' })
    const data = JSON.parse(await fs.readFile(path.join(fixture.dir, 'private', 'remote-commands.json'), 'utf8'))
    expect(data.audit.at(-1)).toMatchObject({ commandId: 'failure', kind: 'message', target: 'session-1', actorFingerprint: 'actor-sha256', outcome: 'failed' })
    expect(JSON.stringify(data.audit)).not.toContain('do not retain')
    expect(JSON.stringify(data)).not.toContain('secret provider context')
  })

  it('fails closed instead of replacing malformed durable evidence', async () => {
    const fixture = await store()
    const privateDir = path.join(fixture.dir, 'private')
    const file = path.join(privateDir, 'remote-commands.json')
    await fs.mkdir(privateDir, { recursive: true })
    await fs.writeFile(file, '{not valid json')
    await expect(fixture.store.execute(request(), async () => null)).rejects.toThrow()
    expect(await fs.readFile(file, 'utf8')).toBe('{not valid json')
  })

  it('rejects a command after its signed delivery window instead of replaying it', async () => {
    const fixture = await store()
    let calls = 0
    await expect(fixture.store.execute({
      ...request('expired'),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    }, async () => ++calls)).rejects.toThrow(/expired/i)
    expect(calls).toBe(0)
  })

  it('enforces exact expiry boundaries and rejects malformed delivery windows', async () => {
    const fixture = await store()
    const timestamp = Date.now()
    let calls = 0
    await expect(fixture.store.execute({
      ...request('expires-now'),
      expiresAt: new Date(timestamp).toISOString(),
    }, async () => ++calls)).rejects.toThrow(/expired/i)
    await expect(fixture.store.execute({
      ...request('max-window'),
      expiresAt: new Date(Date.now() + MAX_REMOTE_COMMAND_TTL_MS).toISOString(),
    }, async () => ++calls)).resolves.toMatchObject({ outcome: 'completed' })
    await expect(fixture.store.execute({
      ...request('too-far'),
      expiresAt: new Date(Date.now() + MAX_REMOTE_COMMAND_TTL_MS + 1_000).toISOString(),
    }, async () => ++calls)).rejects.toThrow(/delivery window/i)
    for (const invalid of ['', 'not-a-date', '2026-99-99T99:99:99Z']) {
      await expect(fixture.store.execute({
        ...request(`invalid-${invalid.length}`),
        expiresAt: invalid,
      }, async () => ++calls)).rejects.toThrow(/expired/i)
    }
    expect(calls).toBe(1)
  })

  it('rejects a deterministic fuzz corpus of unsafe command identifiers', async () => {
    const fixture = await store()
    let calls = 0
    const invalidIds = [
      '',
      '.leading-dot',
      ':leading-colon',
      '../escape',
      'slash/value',
      'white space',
      'line\nbreak',
      'unicode-💥',
      `a${'x'.repeat(128)}`,
    ]
    for (const invalidId of invalidIds) {
      await expect(fixture.store.execute(
        request(invalidId),
        async () => ++calls,
      )).rejects.toThrow(/commandId/i)
    }
    expect(calls).toBe(0)
  })

  it('preserves the payload fingerprint property across adversarial key ordering', () => {
    const entries: Array<[string, unknown]> = [
      ['prompt', 'Continue safely'],
      ['sessionId', 'session-1'],
      ['options', { allow: true, count: 2 }],
      ['paths', ['src/a.ts', 'src/b.ts']],
    ]
    const expected = payloadFingerprint(Object.fromEntries(entries))
    let seed = 0x5eed1234
    const random = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0
      return seed / 0x1_0000_0000
    }
    for (let iteration = 0; iteration < 128; iteration += 1) {
      const shuffled = [...entries]
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1))
        ;[shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]]
      }
      expect(payloadFingerprint(Object.fromEntries(shuffled))).toBe(expected)
    }
    expect(payloadFingerprint({
      ...Object.fromEntries(entries),
      prompt: 'Continue unsafely',
    })).not.toBe(expected)
  })
})
