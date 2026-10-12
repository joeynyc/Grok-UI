import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getFleetSnapshot, getWorkspaceSnapshot, promptControlSession } from '../src/api'
import { requestJson } from '../src/request'

const nativeFetch = globalThis.fetch
const servers: Server[] = []

async function stalledResponse() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.write('{')
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing HTTP test address')
  let headersReceived!: () => void
  const headers = new Promise<void>((resolve) => { headersReceived = resolve })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await nativeFetch(new URL(String(input), `http://127.0.0.1:${address.port}`), init)
    headersReceived()
    return response
  }))
  return { headers }
}

function observe(request: Promise<unknown>) {
  const result: { error?: unknown; completed: boolean } = { completed: false }
  void request.then(
    () => { result.completed = true },
    (error: unknown) => { result.error = error; result.completed = true },
  )
  return result
}

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

describe('browser request lifecycle', () => {
  it('keeps the deadline active after headers while the response body stalls', async () => {
    const { headers } = await stalledResponse()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const result = observe(getFleetSnapshot())
    await headers
    await vi.advanceTimersByTimeAsync(12_000)
    await vi.waitFor(() => expect(result.completed).toBe(true))
    expect(result.error).toEqual(new Error('Request timed out after 12 seconds'))
  })

  it('sets no client deadline on a prompt the server may still be running', async () => {
    const { headers } = await stalledResponse()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const result = observe(promptControlSession('session-1', { cwd: '/workspace', prompt: 'Long replay' }))
    await headers
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(result.completed).toBe(false)
  })

  it('aborts a stalled response body when the caller cancels', async () => {
    const { headers } = await stalledResponse()
    const controller = new AbortController()
    const result = observe(getWorkspaceSnapshot('/workspace', controller.signal))
    await headers
    controller.abort()
    await vi.waitFor(() => expect(result.completed).toBe(true))
    expect(result.error).toMatchObject({ name: 'AbortError' })
  })

  it('preserves a caller-provided cancellation reason while reading the body', async () => {
    const { headers } = await stalledResponse()
    const controller = new AbortController()
    const reason = new Error('Selection changed')
    const result = observe(requestJson('/api/workspace', 'Workspace failed', { signal: controller.signal }))
    await headers
    controller.abort(reason)
    await vi.waitFor(() => expect(result.completed).toBe(true))
    expect(result.error).toBe(reason)
  })

  it('accepts JSON and empty successful responses and releases timers and caller listeners', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('{"count":3}'))
      .mockResolvedValueOnce(new Response(null, { status: 204 })))
    await expect(requestJson('/api/read', 'Read failed', { signal: controller.signal })).resolves.toEqual({ count: 3 })
    await expect(requestJson('/api/delete', 'Delete failed', { method: 'DELETE' })).resolves.toEqual({})
    expect(vi.getTimerCount()).toBe(0)
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it.each([
    ['{', 200, 'Request failed: invalid JSON response'],
    ['{"error":"Permission denied"}', 403, 'Permission denied'],
    ['{}', 503, 'Request failed (503)'],
  ])('preserves response error handling for %s at HTTP %i', async (body, status, message) => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status })))
    await expect(requestJson('/api/test', 'Request failed')).rejects.toThrow(message)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['declared', 'actual'])('retains the %s JSON response size cap', async (kind) => {
    const oversized = 5 * 1024 * 1024 + 1
    const response = kind === 'declared'
      ? new Response('{}', { headers: { 'Content-Length': String(oversized) } })
      : new Response(' '.repeat(oversized))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    await expect(requestJson('/api/test', 'Request failed')).rejects.toThrow('response exceeded the safe size limit')
  })

  it('does not retry a failed mutation', async () => {
    const failure = new TypeError('Failed to fetch')
    const fetchMock = vi.fn().mockRejectedValue(failure)
    vi.stubGlobal('fetch', fetchMock)
    await expect(requestJson('/api/control', 'Control failed', { method: 'POST' })).rejects.toBe(failure)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/control', expect.objectContaining({ method: 'POST' }))
  })
})
