import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { FleetHostConfig } from './types.js'
import { MAX_AGENT_BODY_BYTES } from './fleet-protocol.js'

export const FLEET_REQUEST_TIMEOUT_MS = 3_500

export type FleetConnectionFailureKind =
  | 'unauthorized'
  | 'offline'
  | 'unavailable'
  | 'malformed'

export class FleetConnectionError extends Error {
  constructor(
    readonly kind: FleetConnectionFailureKind,
    message: string,
    readonly status = 0,
  ) {
    super(message)
  }
}

export interface FleetConnector {
  getJson(host: FleetHostConfig, fixedPath: string, timeoutMs?: number): Promise<unknown>
  closeHost?(hostId: string): void
  close?(): Promise<void> | void
}

interface Tunnel {
  signature: string
  child: ChildProcessWithoutNullStreams
  error: string
}

export function sshTunnelArgs(host: FleetHostConfig, timeoutMs: number): string[] {
  return [
    '-N',
    '-T',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1_000))}`,
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=10',
    '-o', 'ServerAliveCountMax=2',
    '-p', String(host.sshPort),
    '-L', `127.0.0.1:${host.localPort}:127.0.0.1:${host.remotePort}`,
    '--',
    host.sshTarget,
  ]
}

function fixedAgentPath(value: string): string {
  if (!value.startsWith('/agent/v1/')) throw new Error('Fleet connector accepts only fixed agent protocol paths.')
  const parsed = new URL(value, 'http://agent.invalid')
  if (parsed.origin !== 'http://agent.invalid' || !parsed.pathname.startsWith('/agent/v1/')) {
    throw new Error('Fleet connector path is invalid.')
  }
  return `${parsed.pathname}${parsed.search}`
}

async function boundedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > MAX_AGENT_BODY_BYTES) {
    throw new FleetConnectionError('malformed', 'Host-agent response exceeded the size limit.')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    bytes += result.value.byteLength
    if (bytes > MAX_AGENT_BODY_BYTES) {
      await reader.cancel()
      throw new FleetConnectionError('malformed', 'Host-agent response exceeded the size limit.')
    }
    chunks.push(result.value)
  }
  const output = new Uint8Array(bytes)
  let offset = 0
  chunks.forEach((chunk) => {
    output.set(chunk, offset)
    offset += chunk.byteLength
  })
  return new TextDecoder().decode(output)
}

async function requestJson(
  baseUrl: string,
  token: string,
  pathName: string,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref()
  try {
    const response = await fetch(new URL(fixedAgentPath(pathName), baseUrl), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      redirect: 'manual',
      signal: controller.signal,
    })
    if (response.status === 401 || response.status === 403) {
      throw new FleetConnectionError('unauthorized', 'Host agent rejected its dedicated access token.', response.status)
    }
    if (response.status >= 300 && response.status < 400) {
      throw new FleetConnectionError('malformed', 'Host agent attempted an unsupported redirect.', response.status)
    }
    const body = await boundedBody(response)
    if (!response.ok) {
      throw new FleetConnectionError('offline', `Host agent returned HTTP ${response.status}.`, response.status)
    }
    try {
      return JSON.parse(body)
    } catch {
      throw new FleetConnectionError('malformed', 'Host agent returned malformed JSON.')
    }
  } catch (error) {
    if (error instanceof FleetConnectionError) throw error
    if (controller.signal.aborted) throw new FleetConnectionError('offline', 'Host-agent request timed out.')
    throw new FleetConnectionError('offline', 'Unable to reach the host agent.')
  } finally {
    clearTimeout(timer)
  }
}

export class DefaultFleetConnector implements FleetConnector {
  private tunnels = new Map<string, Tunnel>()

  async getJson(
    host: FleetHostConfig,
    fixedPath: string,
    timeoutMs = FLEET_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (host.transport === 'ssh') await this.ensureSshTunnel(host, timeoutMs)
    const baseUrl = host.transport === 'ssh'
      ? `http://127.0.0.1:${host.localPort}`
      : host.baseUrl
    return requestJson(baseUrl, host.token, fixedPath, timeoutMs)
  }

  closeHost(hostId: string): void {
    const tunnel = this.tunnels.get(hostId)
    if (!tunnel) return
    this.tunnels.delete(hostId)
    if (tunnel.child.exitCode === null && tunnel.child.signalCode === null) tunnel.child.kill('SIGTERM')
  }

  close(): void {
    ;[...this.tunnels.keys()].forEach((hostId) => this.closeHost(hostId))
  }

  private async ensureSshTunnel(host: FleetHostConfig, timeoutMs: number): Promise<void> {
    const signature = [
      host.sshTarget,
      host.sshPort,
      host.localPort,
      host.remotePort,
    ].join(':')
    const current = this.tunnels.get(host.id)
    if (current && current.signature === signature && current.child.exitCode === null) return
    if (current) this.closeHost(host.id)

    const child = spawn('ssh', sshTunnelArgs(host, timeoutMs), {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const tunnel: Tunnel = { signature, child, error: '' }
    this.tunnels.set(host.id, tunnel)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      tunnel.error = chunk.replace(/\s+/g, ' ').trim().slice(-500)
    })
    child.once('error', (error) => {
      tunnel.error = error.message
    })
    child.once('exit', () => {
      if (this.tunnels.get(host.id)?.child === child) this.tunnels.delete(host.id)
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', () => reject(new FleetConnectionError(
        'unavailable',
        'The local SSH client is unavailable.',
      )))
    })
  }
}
