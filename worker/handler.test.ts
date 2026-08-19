import { describe, expect, it, vi } from 'vitest'
import { handleRequest } from './handler'
import { issueSession } from './security'
import type { Env } from './types'

function environment(fetchImpl?: (request: Request) => Promise<Response>): Env {
  const stub = { fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    if (fetchImpl) return fetchImpl(request)
    if (new URL(request.url).pathname === '/status') return Response.json({})
    return Response.json({ ok: true })
  }) }
  const namespace = { idFromName: vi.fn(() => ({ toString: () => 'id' })), get: vi.fn(() => stub) }
  return {
    CONTROL_PLANE: namespace as unknown as DurableObjectNamespace,
    ENVIRONMENT: 'test', AI_ENABLED: 'true', DEFAULT_MODEL_ENABLED: 'true', NVIDIA_BASE_URL: 'https://nvidia.test/v1', DEFAULT_MODEL: 'one-model', PUBLIC_ORIGIN: 'https://app.test', PROTOCOL_TAG: 'agentroom.v1',
    OPERATING_UPSTREAM_RPM: '28', GLOBAL_DAILY_ATTEMPT_LIMIT: '24000', MAX_CONCURRENT_UPSTREAM: '2', SESSION_HMAC_SECRET: 'session-secret-at-least-long', RISK_HMAC_SECRET: 'risk-secret-at-least-long', MOCK_UPSTREAM: 'true',
  }
}

describe('Worker HTTP integration', () => {
  it('serves only public config and security headers without requiring Origin', async () => {
    const response = await handleRequest(new Request('https://worker.test/api/config'), environment())
    const body = await response.json<Record<string, unknown>>()
    expect(body).toMatchObject({ releaseClass: 'PUBLIC_BETA', protocolTag: 'agentroom.v1', aiEnabled: true })
    expect(body).not.toHaveProperty('model')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('rejects originless sensitive APIs before session or coordinator use', async () => {
    const response = await handleRequest(new Request('https://worker.test/api/session', { method: 'POST', body: '{}' }), environment())
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'INVALID_REQUEST' } })
  })

  it('rejects a third-party Origin and fails closed when the coordinator is unavailable', async () => {
    const env = environment()
    const thirdParty = await handleRequest(new Request('https://worker.test/api/session', { method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{}' }), env)
    expect(thirdParty.status).toBe(403)
    const cookie = await issueSession({ sessionId: 'session-id', expiresAt: Date.now() + 60_000 }, env.SESSION_HMAC_SECRET)
    const rejectingStub = { fetch: vi.fn().mockRejectedValue(new Error('coordinator unavailable')) }
    env.CONTROL_PLANE = { idFromName: vi.fn(() => ({ toString: () => 'id' })), get: vi.fn(() => rejectingStub) } as unknown as DurableObjectNamespace
    const unavailable = await handleRequest(new Request('https://worker.test/api/rooms/room-0001/control', {
      method: 'PATCH', headers: { origin: env.PUBLIC_ORIGIN, cookie: `ar_session=${cookie}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'pause', idempotencyKey: 'pause-key-0001', controlRevision: 1 }),
    }), env)
    expect(unavailable.status).toBe(503)
    await expect(unavailable.json()).resolves.toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } })
  })

  it('forwards the frontend skip revision and failed server turn metadata', async () => {
    let skipBody: Record<string, unknown> | undefined
    const env = environment(async (request) => {
      const path = new URL(request.url).pathname
      if (path === '/session/validate') return Response.json({ ok: true })
      if (path === '/rooms/skip') { skipBody = await request.json<Record<string, unknown>>(); return Response.json({ controlRevision: 8 }) }
      return Response.json({})
    })
    const cookie = await issueSession({ sessionId: 'session-id', expiresAt: Date.now() + 60_000 }, env.SESSION_HMAC_SECRET)
    const response = await handleRequest(new Request('https://worker.test/api/rooms/room-0001/skip', {
      method: 'POST', headers: { origin: env.PUBLIC_ORIGIN, cookie: `ar_session=${cookie}`, 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'skip-key-0001', controlRevision: 7, serverTurnId: '11111111-1111-4111-8111-111111111111' }),
    }), env)
    expect(response.status).toBe(200)
    expect(skipBody).toMatchObject({ controlRevision: 7, serverTurnId: '11111111-1111-4111-8111-111111111111' })
  })

  it('requires a successful hostname/action-bound Siteverify before accepting a challenge', async () => {
    let createBody: Record<string, unknown> | undefined
    const env = environment(async (request) => {
      if (new URL(request.url).pathname === '/session/create') {
        createBody = await request.json<Record<string, unknown>>()
        return Response.json({ ok: true })
      }
      return Response.json({})
    })
    env.TURNSTILE_SECRET_KEY = 'turnstile-secret'
    const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ success: true, hostname: 'app.test', action: 'agentroom-session' }))
    try {
      const response = await handleRequest(new Request('https://worker.test/api/session', { method: 'POST', headers: { origin: env.PUBLIC_ORIGIN, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1' }, body: JSON.stringify({ challengeToken: 'single-use-token' }) }), env)
      expect(response.status).toBe(200)
      expect(response.headers.get('set-cookie')).toContain('HttpOnly')
      expect(createBody?.challengeHash).toEqual(expect.any(String))
      expect(JSON.stringify(createBody)).not.toContain('single-use-token')
    } finally { upstream.mockRestore() }
  })

  it('rejects a failed Siteverify response without creating or verifying a session', async () => {
    const control = vi.fn(async () => Response.json({ ok: true }))
    const env = environment(control)
    env.TURNSTILE_SECRET_KEY = 'turnstile-secret'
    const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ success: false, hostname: 'app.test', action: 'agentroom-session' }))
    try {
      const response = await handleRequest(new Request('https://worker.test/api/session', { method: 'POST', headers: { origin: env.PUBLIC_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ challengeToken: 'invalid-token' }) }), env)
      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'CHALLENGE_REQUIRED' } })
      expect(control).not.toHaveBeenCalled()
    } finally { upstream.mockRestore() }
  })

  it('silently replaces a signed cookie whose durable session has expired', async () => {
    const paths: string[] = []
    const env = environment(async (request) => {
      const path = new URL(request.url).pathname; paths.push(path)
      if (path === '/session/exists') return Response.json({ error: { code: 'SESSION_EXPIRED' } }, { status: 401 })
      if (path === '/session/create') return Response.json({ ok: true })
      return Response.json({})
    })
    const oldCookie = await issueSession({ sessionId: 'expired-session', expiresAt: Date.now() + 60 * 60_000 }, env.SESSION_HMAC_SECRET)
    const response = await handleRequest(new Request('https://worker.test/api/session', { method: 'POST', headers: { origin: env.PUBLIC_ORIGIN, cookie: `ar_session=${oldCookie}`, 'content-type': 'application/json', 'cf-connecting-ip': '2001:db8::1' }, body: '{}' }), env)
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain('ar_session=')
    expect(paths).toEqual(['/session/exists', '/session/create'])
  })

  it('streams normalized queued/start/content/done and commits control metadata', async () => {
    const paths: string[] = []
    const env = environment(async (request) => {
      const path = new URL(request.url).pathname; paths.push(path)
      if (path === '/session/validate') return Response.json({ ok: true })
      if (path === '/turn/begin') return Response.json({ serverTurnId: '11111111-1111-4111-8111-111111111111', leaseId: '22222222-2222-4222-8222-222222222222', speakerId: 'agent-0001', speakerNameKey: 'alex', boosted: false, queueState: 'short', expiresAt: Date.now() + 1000 })
      if (path === '/quota/acquire') return Response.json({ leaseId: 'quota-lease', expiresAt: Date.now() + 1000, queueState: 'short' })
      if (path === '/turn/finish') return Response.json({ controlRevision: 2, runTurnsCompleted: 1, totalTurnsCompleted: 1 })
      return Response.json({ ok: true })
    })
    const cookie = await issueSession({ sessionId: 'session-id', expiresAt: Date.now() + 60_000 }, env.SESSION_HMAC_SECRET)
    const body = {
      requestId: '33333333-3333-4333-8333-333333333333', idempotencyKey: '44444444-4444-4444-8444-444444444444', roomId: 'room-0001', runId: 'run-00001', protocolTag: 'agentroom.v1', appBuildId: 'test-build', topic: 'Ship safely',
      agents: [
        { id: 'agent-0001', name: 'Alex', normalizedName: 'alex', role: 'PM', avatar: 'A', personality: 'direct', goal: 'ship', enabled: true },
        { id: 'agent-0002', name: 'Maya', normalizedName: 'maya', role: 'Engineer', avatar: 'M', personality: 'careful', goal: 'build', enabled: true },
      ],
      messages: [{ id: 'message-0001', senderType: 'user', senderName: 'You', content: 'What next?', status: 'completed', createdAt: Date.now() }],
    }
    const response = await handleRequest(new Request('https://worker.test/api/rooms/room-0001/turn', { method: 'POST', headers: { origin: env.PUBLIC_ORIGIN, cookie: `ar_session=${cookie}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env)
    expect(response.status).toBe(200)
    const stream = await response.text()
    expect(stream).toContain('event: queued')
    expect(stream).toContain('event: start')
    expect(stream).toContain('Mock response.')
    expect(stream).toContain('event: done')
    expect(stream).toContain('"controlRevision":2')
    expect(stream).not.toContain(env.SESSION_HMAC_SECRET)
    expect(paths).toEqual(expect.arrayContaining(['/turn/begin', '/quota/acquire', '/quota/release', '/turn/finish']))
  })

  it('charges a fresh permit for the one allowed pre-token transient retry', async () => {
    const paths: string[] = []
    const env = environment(async (request) => {
      const path = new URL(request.url).pathname; paths.push(path)
      if (path === '/session/validate') return Response.json({ ok: true })
      if (path === '/turn/begin') return Response.json({ serverTurnId: '11111111-1111-4111-8111-111111111111', leaseId: '22222222-2222-4222-8222-222222222222', speakerId: 'agent-0001', speakerNameKey: 'alex', boosted: false, queueState: 'short', expiresAt: Date.now() + 1000 })
      if (path === '/quota/acquire') return Response.json({ leaseId: `quota-${paths.filter((item) => item === path).length}`, expiresAt: Date.now() + 1000 })
      if (path === '/turn/finish') return Response.json({ controlRevision: 2, runTurnsCompleted: 1, totalTurnsCompleted: 1 })
      return Response.json({ ok: true })
    })
    env.MOCK_UPSTREAM = 'false'; env.NVIDIA_API_KEY = 'not-a-real-key'
    const upstream = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }))
    try {
      const cookie = await issueSession({ sessionId: 'session-id', expiresAt: Date.now() + 60_000 }, env.SESSION_HMAC_SECRET)
      const body = {
        requestId: '33333333-3333-4333-8333-333333333333', idempotencyKey: '44444444-4444-4444-8444-444444444444', roomId: 'room-0001', runId: 'run-00001', protocolTag: 'agentroom.v1', appBuildId: 'test-build', topic: 'Ship safely',
        agents: [{ id: 'agent-0001', name: 'Alex', role: 'PM', avatar: 'A', personality: 'direct', goal: 'ship', enabled: true }, { id: 'agent-0002', name: 'Maya', role: 'Engineer', avatar: 'M', personality: 'careful', goal: 'build', enabled: true }],
        messages: [{ id: 'message-0001', senderType: 'user', senderName: 'You', content: 'What next?', status: 'completed', createdAt: Date.now() }],
      }
      const response = await handleRequest(new Request('https://worker.test/api/rooms/room-0001/turn', { method: 'POST', headers: { origin: env.PUBLIC_ORIGIN, cookie: `ar_session=${cookie}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env)
      expect(await response.text()).toContain('recovered')
      expect(paths.filter((path) => path === '/quota/acquire')).toHaveLength(2)
      expect(paths.filter((path) => path === '/quota/release')).toHaveLength(2)
      expect(upstream).toHaveBeenCalledTimes(2)
    } finally { upstream.mockRestore() }
  })
})
