import type { Env, SessionIdentity } from './types'

const encoder = new TextEncoder()

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))))
}

async function verifyHmac(secret: string, value: string, signature: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    const signatureBytes = decode(signature)
    return crypto.subtle.verify('HMAC', key, signatureBytes.buffer.slice(signatureBytes.byteOffset, signatureBytes.byteOffset + signatureBytes.byteLength) as ArrayBuffer, encoder.encode(value))
  } catch { return false }
}

export async function issueSession(identity: SessionIdentity, secret: string): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify({ sid: identity.sessionId, exp: identity.expiresAt })))
  return `${payload}.${await hmac(secret, payload)}`
}

export async function readSession(request: Request, secret: string): Promise<SessionIdentity | undefined> {
  const cookie = request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith('ar_session='))?.slice(11)
  if (!cookie) return undefined
  const [payload, signature, extra] = cookie.split('.')
  if (!payload || !signature || extra || !(await verifyHmac(secret, payload, signature))) return undefined
  try {
    const parsed = JSON.parse(new TextDecoder().decode(decode(payload))) as { sid?: unknown; exp?: unknown }
    if (typeof parsed.sid !== 'string' || typeof parsed.exp !== 'number' || !Number.isFinite(parsed.exp) || parsed.exp <= 0) return undefined
    return { sessionId: parsed.sid, expiresAt: parsed.exp }
  } catch { return undefined }
}

export async function trustedRequest(request: Request, env: Env): Promise<boolean> {
  const origin = request.headers.get('origin')
  if (origin === env.PUBLIC_ORIGIN) return true
  const timestamp = request.headers.get('x-agentroom-smoke-timestamp')
  const signature = request.headers.get('x-agentroom-smoke-signature')
  const timestampMs = Number(timestamp)
  if (!env.SMOKE_TEST_SECRET || !timestamp || !signature || !Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60_000) return false
  const url = new URL(request.url)
  return verifyHmac(env.SMOKE_TEST_SECRET, `${request.method}\n${url.pathname}\n${timestamp}`, signature)
}

export function securityHeaders(origin?: string): Headers {
  const headers = new Headers({
    'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer', 'strict-transport-security': 'max-age=31536000', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  })
  if (origin) { headers.set('access-control-allow-origin', origin); headers.set('vary', 'Origin'); headers.set('access-control-allow-credentials', 'true') }
  return headers
}

export function withSecurity(response: Response, request: Request, env: Env): Response {
  const headers = new Headers(response.headers)
  const secured = securityHeaders(request.headers.get('origin') === env.PUBLIC_ORIGIN ? env.PUBLIC_ORIGIN : undefined)
  secured.forEach((value, key) => headers.set(key, value))
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
