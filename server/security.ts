import crypto from 'node:crypto'
import type express from 'express'
import { PREVIEW_PUBLIC_HOST } from './preview-supervisor.js'

const SESSION_COOKIE = 'grok_ui_session'
const SESSION_TTL_MS = 12 * 60 * 60_000

function loopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function equalSecret(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

function cookieValue(request: express.Request, key: string): string {
  const header = request.headers.cookie || ''
  for (const item of header.split(';')) {
    const [name, ...value] = item.trim().split('=')
    if (name === key) return decodeURIComponent(value.join('='))
  }
  return ''
}

export class SecurityGate {
  readonly authRequired: boolean
  private readonly token: string
  private readonly sessions = new Map<string, number>()

  constructor(host: string, token = process.env.GROK_UI_TOKEN || '') {
    if (!loopback(host) && !token) {
      throw new Error('GROK_UI_TOKEN is required when HOST is not a loopback address.')
    }
    this.token = token
    this.authRequired = Boolean(token)
  }

  headers: express.RequestHandler = (_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    response.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; base-uri 'none'; frame-ancestors 'none'; frame-src 'self' http://${PREVIEW_PUBLIC_HOST}:*; form-action 'self'; img-src 'self' data:; font-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'`,
    )
    if (_request.path.startsWith('/api/')) response.setHeader('Cache-Control', 'no-store')
    next()
  }

  status: express.RequestHandler = (request, response) => {
    response.json({
      required: this.authRequired,
      authenticated: !this.authRequired || this.isAuthenticated(request),
    })
  }

  login: express.RequestHandler = (request, response) => {
    if (!this.authRequired) {
      response.json({ authenticated: true })
      return
    }
    const candidate = typeof request.body?.token === 'string' ? request.body.token : ''
    if (!candidate || !equalSecret(candidate, this.token)) {
      response.status(401).json({ error: 'Invalid access token.' })
      return
    }
    const sessionId = crypto.randomBytes(32).toString('base64url')
    this.sessions.set(sessionId, Date.now() + SESSION_TTL_MS)
    response.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
    )
    response.json({ authenticated: true })
  }

  logout: express.RequestHandler = (request, response) => {
    const sessionId = cookieValue(request, SESSION_COOKIE)
    if (sessionId) this.sessions.delete(sessionId)
    response.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    )
    response.json({ authenticated: false })
  }

  protect: express.RequestHandler = (request, response, next) => {
    if (!this.authRequired || this.isAuthenticated(request)) {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !this.validMutationOrigin(request)) {
        response.status(403).json({ error: 'Cross-origin mutation rejected.' })
        return
      }
      next()
      return
    }
    response.status(401).json({ error: 'Authentication required.' })
  }

  private isAuthenticated(request: express.Request): boolean {
    const authorization = request.headers.authorization || ''
    if (authorization.startsWith('Bearer ') && equalSecret(authorization.slice(7), this.token)) return true
    const sessionId = cookieValue(request, SESSION_COOKIE)
    const expiresAt = this.sessions.get(sessionId) || 0
    if (expiresAt > Date.now()) return true
    if (sessionId) this.sessions.delete(sessionId)
    return false
  }

  private validMutationOrigin(request: express.Request): boolean {
    if ((request.headers.authorization || '').startsWith('Bearer ')) return true
    const origin = request.headers.origin
    if (!origin) return true
    try {
      return new URL(origin).host === request.headers.host
    } catch {
      return false
    }
  }
}
