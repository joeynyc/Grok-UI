import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const TIMEOUT_MS = 3_500
const MAX_OUTPUT = 64_000

export interface ModelOption {
  id: string
  label: string
}

export interface InspectSnapshot {
  cwd: string
  generatedAt: string
  text: string
}

function grokBin(): string {
  return process.env.GROK_BIN || 'grok'
}

function clip(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, '').slice(0, MAX_OUTPUT).trim()
}

export function parseModelList(output: string): ModelOption[] {
  const seen = new Set<string>()
  const models: ModelOption[] = []
  for (const raw of clip(output).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.toLowerCase().includes('available model')) continue
    const id = line.replace(/^[*\-•]\s+/, '').split(/\s+/)[0]
    if (!id || seen.has(id)) continue
    seen.add(id)
    models.push({ id, label: line.replace(/^[*\-•]\s+/, '').slice(0, 120) })
    if (models.length >= 64) break
  }
  return models
}

export async function listGrokModels(): Promise<ModelOption[]> {
  const { stdout, stderr } = await execFileAsync(grokBin(), ['models'], {
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT,
    env: { ...process.env, NO_COLOR: '1' },
  })
  return parseModelList(`${stdout}\n${stderr}`)
}

export async function inspectWorkspace(cwd: string): Promise<InspectSnapshot> {
  const { stdout, stderr } = await execFileAsync(grokBin(), ['inspect'], {
    cwd,
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT,
    env: { ...process.env, NO_COLOR: '1' },
  })
  return {
    cwd,
    generatedAt: new Date().toISOString(),
    text: clip(`${stdout}\n${stderr}`) || 'Grok inspect returned no configuration.',
  }
}

export async function deleteGrokSession(sessionId: string, cwd: string): Promise<void> {
  await execFileAsync(grokBin(), ['sessions', 'delete', sessionId], {
    cwd,
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT,
    env: { ...process.env, NO_COLOR: '1' },
  })
}
