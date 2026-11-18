import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import express from 'express'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index < 0 ? fallback : process.argv[index + 1]
}

const sourceRoot = path.resolve(option('--source-root', projectRoot))
const iterations = Number(option('--iterations', '300'))
const warmups = Number(option('--warmups', '15'))
const sessionCount = Number(option('--sessions', '100'))

if (![iterations, warmups, sessionCount].every(Number.isSafeInteger)
  || iterations < 1 || warmups < 0 || sessionCount < 1) {
  throw new Error('--iterations and --sessions must be positive integers; --warmups must be nonnegative')
}

const sourceRevision = execFileSync('git', ['-C', sourceRoot, 'rev-parse', '--short', 'HEAD'], {
  encoding: 'utf8',
}).trim()
const storeSourceStatus = execFileSync('git', ['-C', sourceRoot, 'status', '--short', '--', 'server/grok-store.ts'], {
  encoding: 'utf8',
}).trim() || 'clean'
const { GrokStore } = await import(pathToFileURL(path.join(sourceRoot, 'server/grok-store.ts')).href)
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-dashboard-bench-'))
const grokHome = path.join(fixtureRoot, 'grok-home')
let fixtureFiles = 0
let fixtureBytes = 0

async function writeFixtureFile(file, contents) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, contents)
  fixtureFiles += 1
  fixtureBytes += Buffer.byteLength(contents)
}

async function createFixture() {
  const writes = []
  for (let index = 0; index < sessionCount; index += 1) {
    const id = `session-${String(index).padStart(4, '0')}`
    const workspace = `/bench/workspace-${String(index % 10).padStart(2, '0')}`
    const directory = path.join(grokHome, 'sessions', encodeURIComponent(workspace), id)
    const summary = {
      info: { id, cwd: workspace },
      generated_title: `Synthetic dashboard session ${index}`,
      session_summary: 'Deterministic benchmark fixture',
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-02-01T00:00:00.000Z',
      current_model_id: 'grok-benchmark-model',
      num_messages: 20,
      num_chat_messages: 10,
    }
    const signals = {
      turnCount: 8,
      toolCallCount: 12,
      errorCount: 0,
      toolFailureCount: 0,
      contextWindowUsage: 42,
      totalFilesTouched: 3,
      agentLinesAdded: 40,
      agentLinesRemoved: 8,
      toolsUsed: ['read_file', 'write_file', 'run_command'],
      modelsUsed: ['grok-benchmark-model'],
    }
    writes.push(writeFixtureFile(path.join(directory, 'summary.json'), JSON.stringify(summary)))
    writes.push(writeFixtureFile(path.join(directory, 'signals.json'), JSON.stringify(signals)))
    writes.push(writeFixtureFile(path.join(directory, 'updates.jsonl'), '{"type":"tool_call"}\n'))
    writes.push(writeFixtureFile(path.join(directory, 'transcript.jsonl'), '{"type":"message"}\n'))
  }

  for (let index = 0; index < 12; index += 1) {
    const directory = path.join(grokHome, 'bundled', 'skills', `skill-${index}`)
    writes.push(writeFixtureFile(path.join(directory, 'SKILL.md'), '# Synthetic skill\n'))
  }
  for (let index = 0; index < 12; index += 1) {
    writes.push(writeFixtureFile(
      path.join(grokHome, 'memory', `workspace-${index}`, 'MEMORY.md'),
      '# Synthetic memory metadata\n',
    ))
  }
  writes.push(writeFixtureFile(path.join(grokHome, 'version.json'), '{"version":"bench"}'))
  await Promise.all(writes)
}

function percentile(samples, quantile) {
  const ordered = [...samples].sort((left, right) => left - right)
  return Number(ordered[Math.ceil(quantile * ordered.length) - 1].toFixed(3))
}

async function measure(url, concurrency, batches) {
  const samples = []
  for (let batch = 0; batch < warmups + batches; batch += 1) {
    const latencies = await Promise.all(Array.from({ length: concurrency }, async () => {
      const startedAt = performance.now()
      const response = await fetch(`${url}/api/dashboard?refresh=1`)
      const payload = await response.json()
      const elapsed = performance.now() - startedAt
      if (!response.ok || payload.sessions.length !== sessionCount) {
        throw new Error(`Unexpected dashboard response: HTTP ${response.status}, ${payload.sessions.length} sessions`)
      }
      return elapsed
    }))
    if (batch >= warmups) samples.push(...latencies)
  }
  return {
    concurrency,
    observations: samples.length,
    warmupBatches: warmups,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
  }
}

let server
try {
  await createFixture()
  const store = new GrokStore(grokHome)
  const app = express()
  app.get('/api/dashboard', async (request, response, next) => {
    try {
      response.json(await store.dashboard(request.query.refresh === '1'))
    } catch (error) {
      next(error)
    }
  })

  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}`
  const results = []
  const cpuStarted = process.cpuUsage()
  const measurementStartedAt = performance.now()
  for (const concurrency of [1, 8]) {
    results.push(await measure(url, concurrency, iterations))
  }
  const measurementElapsedMs = performance.now() - measurementStartedAt
  const cpuUsage = process.cpuUsage(cpuStarted)

  console.log(JSON.stringify({
    benchmark: 'isolated Express GET /api/dashboard handler with production GrokStore',
    sourceRoot,
    sourceRevision,
    storeSourceStatus,
    endpoint: `${url}/api/dashboard?refresh=1`,
    latency: 'loopback fetch through response JSON parsing; forced store rebuild per burst',
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      cpuModel: os.cpus()[0]?.model || 'unknown',
      logicalCpus: os.cpus().length,
      measurementElapsedMs: Number(measurementElapsedMs.toFixed(1)),
      processCpuMs: {
        user: Number((cpuUsage.user / 1_000).toFixed(1)),
        system: Number((cpuUsage.system / 1_000).toFixed(1)),
      },
    },
    fixture: {
      sessions: sessionCount,
      files: fixtureFiles,
      bytes: fixtureBytes,
    },
    iterationsPerConcurrency: iterations,
    results,
  }, null, 2))
} finally {
  try {
    if (server?.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true })
  }
}
