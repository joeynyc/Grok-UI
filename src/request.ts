const JSON_RESPONSE_CAP = 5 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 12_000

export async function readJsonResponse<T>(response: Response, fallback: string): Promise<T> {
  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (declaredLength > JSON_RESPONSE_CAP) throw new Error(`${fallback}: response exceeded the safe size limit`)
  const text = await response.text()
  if (text.length > JSON_RESPONSE_CAP) throw new Error(`${fallback}: response exceeded the safe size limit`)
  let payload: { error?: string } = {}
  try {
    payload = text ? JSON.parse(text) as { error?: string } : {}
  } catch {
    throw new Error(`${fallback}: invalid JSON response`)
  }
  if (!response.ok) throw new Error(payload.error || `${fallback} (${response.status})`)
  return payload as T
}

export async function requestJson<T>(
  input: RequestInfo | URL,
  fallback: string,
  init: RequestInit = {},
  timeoutMs: number | null = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController()
  const callerSignal = init.signal
  const cancel = () => controller.abort(callerSignal?.reason)
  if (callerSignal?.aborted) cancel()
  else callerSignal?.addEventListener('abort', cancel, { once: true })
  let timedOut = false
  const timer = timeoutMs === null ? undefined : globalThis.setTimeout(() => {
    if (controller.signal.aborted) return
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    const response = await fetch(input, { ...init, signal: controller.signal })
    return await readJsonResponse<T>(response, fallback)
  } catch (error) {
    if (timedOut) throw new Error(`Request timed out after ${Math.round((timeoutMs ?? 0) / 1_000)} seconds`)
    if (callerSignal?.aborted) throw callerSignal.reason
    throw error
  } finally {
    globalThis.clearTimeout(timer)
    callerSignal?.removeEventListener('abort', cancel)
  }
}
