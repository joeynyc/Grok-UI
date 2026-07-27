import http from 'node:http'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DefaultFleetConnector,
  FleetConnectionError,
  waitForLoopbackPort,
} from './fleet-connectors.js'
import { MAX_AGENT_BODY_BYTES } from './fleet-protocol.js'
import type { FleetHostConfig } from './types.js'

const servers: Array<http.Server | net.Server> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function listen(server: http.Server | net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve)
    server.once('error', reject)
  })
  servers.push(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not expose a port.')
  return address.port
}

async function availablePort(): Promise<number> {
  const reservation = net.createServer()
  const port = await listen(reservation)
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  servers.splice(servers.indexOf(reservation), 1)
  return port
}

function host(port: number): FleetHostConfig {
  return {
    id: 'connector-host',
    label: 'Connector host',
    transport: 'direct',
    baseUrl: `http://127.0.0.1:${port}`,
    token: 'connector-secret',
    sshTarget: '',
    sshPort: 22,
    localPort: 0,
    remotePort: 4311,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

describe('DefaultFleetConnector', () => {
  it('waits for a delayed loopback listener and respects its timeout', async () => {
    const port = await availablePort()
    const delayed = net.createServer((socket) => socket.end())
    const start = setTimeout(() => {
      delayed.listen(port, '127.0.0.1')
      servers.push(delayed)
    }, 40)
    try {
      expect(await waitForLoopbackPort(port, 500)).toBe(true)
    } finally {
      clearTimeout(start)
    }

    const unavailable = await availablePort()
    expect(await waitForLoopbackPort(unavailable, 40)).toBe(false)
  })

  it('rejects redirects, arbitrary paths, and streamed bodies above the cap', async () => {
    const server = http.createServer((request, response) => {
      if (request.url === '/agent/v1/redirect') {
        response.writeHead(302, { Location: '/agent/v1/hello' }).end()
        return
      }
      if (request.url === '/agent/v1/large') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ payload: 'x'.repeat(MAX_AGENT_BODY_BYTES) }))
        return
      }
      response.end(JSON.stringify({ ok: true }))
    })
    const port = await listen(server)
    const connector = new DefaultFleetConnector()

    await expect(connector.getJson(host(port), 'https://example.com/agent/v1/hello'))
      .rejects.toMatchObject<FleetConnectionError>({ kind: 'malformed' })
    await expect(connector.getJson(host(port), '/agent/v1/redirect'))
      .rejects.toMatchObject<FleetConnectionError>({ kind: 'malformed' })
    await expect(connector.getJson(host(port), '/agent/v1/large'))
      .rejects.toMatchObject<FleetConnectionError>({ kind: 'malformed' })
  })
})
