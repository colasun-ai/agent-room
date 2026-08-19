import { CONTROL_SCHEMA_REVISION, PROTOCOL_TAG, type ApiError, type ErrorCode, type StreamEvent } from '../shared/protocol'
import { buildPrompt } from './prompt'
import { NvidiaProvider, ProviderError } from './provider'
import { parseMentions } from './scheduler'
import { hmac, issueSession, readSession, trustedRequest, withSecurity } from './security'
import type { Env, SessionIdentity, TurnBeginResult } from './types'
import { readJson, validateControl, validateRegister, validateSkip, validateTurn } from './validation'

const encoder = new TextEncoder()

function apiError(code: ErrorCode, status: number, requestId?: string, retryable = false, retryAfterMs?: number): Response {
  const body: ApiError = { error: { code, message: code, requestId, retryable, retryAfterMs } }
  return Response.json(body, { status })
}

function coordinator(env: Env): DurableObjectStub {
  return env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('nvidia-quota-group'))
}

async function controlCall(env: Env, path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return coordinator(env).fetch(new Request(`https://control.internal${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal }))
}

async function forwardControl(response: Response, requestId?: string): Promise<Response> {
  let data: { error?: { code?: ErrorCode; retryable?: boolean; retryAfterMs?: number } } = {}
  try { data = await response.json<typeof data>() } catch { /* invalid coordinator response */ }
  if (!data.error?.code) return apiError('SERVICE_UNAVAILABLE', 503, requestId, true)
  return apiError(data.error.code, response.status, requestId, Boolean(data.error.retryable), data.error.retryAfterMs)
}

async function requireSession(request: Request, env: Env): Promise<SessionIdentity | Response> {
  const identity = await readSession(request, env.SESSION_HMAC_SECRET)
  if (!identity) return apiError('SESSION_REQUIRED', 401)
  if (identity.expiresAt <= Date.now()) return apiError('SESSION_EXPIRED', 401)
  const checked = await controlCall(env, '/session/validate', { sessionId: identity.sessionId, now: Date.now() })
  if (!checked.ok) return forwardControl(checked)
  return identity
}

async function verifyTurnstile(token: string, request: Request, env: Env): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return false
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, idempotency_key: crypto.randomUUID() })
  const remoteIp = request.headers.get('cf-connecting-ip')
  if (remoteIp) form.set('remoteip', remoteIp)
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form, signal: AbortSignal.timeout(8_000) }).catch(() => undefined)
  if (!response?.ok) return false
  let result: { success?: boolean; hostname?: string; action?: string } = {}
  try { result = await response.json<typeof result>() } catch { /* invalid Siteverify response */ }
  const expectedHostname = env.TURNSTILE_EXPECTED_HOSTNAME ?? new URL(env.PUBLIC_ORIGIN).hostname
  return result.success === true && result.hostname === expectedHostname && result.action === 'agentroom-session'
}

async function createSession(request: Request, env: Env): Promise<Response> {
  let body: { challengeToken?: unknown } = {}
  try { body = await readJson(request, 8_000) as typeof body } catch { return apiError('INVALID_REQUEST', 400) }
  const challengeToken = typeof body.challengeToken === 'string' ? body.challengeToken : undefined
  let challengeHash: string | undefined
  if (challengeToken) {
    if (!(await verifyTurnstile(challengeToken, request, env))) return apiError('CHALLENGE_REQUIRED', 403)
    challengeHash = await hmac(env.RISK_HMAC_SECRET ?? env.SESSION_HMAC_SECRET, challengeToken)
  }
  const now = Date.now(), sessionId = crypto.randomUUID(), expiresAt = now + 24 * 60 * 60_000
  const rawNetwork = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const riskKey = await hmac(env.RISK_HMAC_SECRET ?? env.SESSION_HMAC_SECRET, rawNetwork)
  const created = await controlCall(env, '/session/create', { sessionId, riskKey, now, expiresAt, idleExpiresAt: now + 2 * 60 * 60_000, challengeHash })
  if (!created.ok) return forwardControl(created)
  const cookie = await issueSession({ sessionId, expiresAt }, env.SESSION_HMAC_SECRET)
  return new Response(null, { status: 204, headers: { 'set-cookie': `ar_session=${cookie}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Strict` } })
}

async function config(env: Env): Promise<Response> {
  let state: { killed?: boolean; cooldown?: boolean; dailyExhausted?: boolean; busy?: boolean } = {}
  try { state = await (await coordinator(env).fetch('https://control.internal/status')).json<typeof state>() } catch { state = { killed: true } }
  const credentialAvailable = Boolean(env.NVIDIA_API_KEY) || (env.ENVIRONMENT !== 'production' && env.MOCK_UPSTREAM === 'true')
  const enabled = env.AI_ENABLED === 'true' && env.DEFAULT_MODEL_ENABLED !== 'false' && credentialAvailable && !state.killed
  const capacityState = !enabled ? 'disabled' : state.dailyExhausted ? 'daily-exhausted' : state.cooldown || state.busy ? 'busy' : 'available'
  return Response.json({ releaseClass: 'PUBLIC_BETA', protocolTag: PROTOCOL_TAG, controlSchemaRevision: CONTROL_SCHEMA_REVISION, aiEnabled: enabled, capacityState, limits: { agentsMin: 2, agentsMax: 6, turnLimits: [6, 12, 20] }, ...(env.TURNSTILE_SITE_KEY ? { turnstileSiteKey: env.TURNSTILE_SITE_KEY } : {}) })
}

async function register(request: Request, env: Env, session: SessionIdentity): Promise<Response> {
  try {
    const payload = validateRegister(await readJson(request))
    const response = await controlCall(env, '/rooms/register', { ...payload, sessionId: session.sessionId, now: Date.now() })
    return response.ok ? new Response(response.body, response) : forwardControl(response)
  } catch { return apiError('INVALID_REQUEST', 400) }
}

async function control(request: Request, env: Env, session: SessionIdentity, roomId: string): Promise<Response> {
  try {
    const payload = validateControl(await readJson(request))
    const response = await controlCall(env, '/rooms/control', { ...payload, roomId, sessionId: session.sessionId, now: Date.now() })
    return response.ok ? new Response(response.body, response) : forwardControl(response)
  } catch { return apiError('INVALID_REQUEST', 400) }
}

async function skip(request: Request, env: Env, session: SessionIdentity, roomId: string): Promise<Response> {
  try {
    const payload = validateSkip(await readJson(request, 10_000))
    const response = await controlCall(env, '/rooms/skip', { ...payload, roomId, sessionId: session.sessionId, now: Date.now() })
    return response.ok ? new Response(response.body, response) : forwardControl(response)
  } catch { return apiError('INVALID_REQUEST', 400) }
}

function streamFrame(event: StreamEvent): Uint8Array {
  return encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
}

function mapProviderError(error: ProviderError): { code: ErrorCode; retryable: boolean; retryAfterMs?: number } {
  if (error.kind === 'aborted') return { code: 'REQUEST_ABORTED', retryable: false }
  if (error.kind === 'auth') return { code: 'UPSTREAM_AUTH_ERROR', retryable: false }
  if (error.kind === 'rate') return { code: 'UPSTREAM_RATE_LIMITED', retryable: true, retryAfterMs: error.retryAfterMs }
  if (error.kind === 'timeout' || error.kind === 'transient') return { code: 'MODEL_UNAVAILABLE', retryable: true }
  return { code: 'MODEL_UNAVAILABLE', retryable: false }
}

async function turn(request: Request, env: Env, session: SessionIdentity, roomId: string): Promise<Response> {
  if (env.AI_ENABLED !== 'true' || env.DEFAULT_MODEL_ENABLED === 'false') return apiError('SERVICE_DISABLED', 503)
  if (!env.NVIDIA_API_KEY && !(env.ENVIRONMENT !== 'production' && env.MOCK_UPSTREAM === 'true')) return apiError('SERVICE_DISABLED', 503)
  let payload
  try { payload = validateTurn(await readJson(request), roomId) } catch { return apiError('INVALID_REQUEST', 400) }
  const latestUserDirectAddress = [...payload.messages].reverse().find((message) => message.senderType === 'user')?.content
  const begunResponse = await controlCall(env, '/turn/begin', { sessionId: session.sessionId, requestId: payload.requestId, idempotencyKey: payload.idempotencyKey, roomId, runId: payload.runId, latestUserDirectAddress, retryOfServerTurnId: payload.retryOfServerTurnId, now: Date.now() })
  if (!begunResponse.ok) return forwardControl(begunResponse, payload.requestId)
  const begun = await begunResponse.json<TurnBeginResult>()
  const speaker = payload.agents.find((agent) => agent.id === begun.speakerId && agent.enabled && agent.normalizedName === begun.speakerNameKey)
  if (!speaker) {
    await controlCall(env, '/turn/fail', { sessionId: session.sessionId, roomId, leaseId: begun.leaseId, serverTurnId: begun.serverTurnId, now: Date.now() })
    return apiError('INVALID_REQUEST', 400, payload.requestId)
  }
  const roster = payload.agents.map((agent) => ({ agentId: agent.id, nameKey: agent.normalizedName, enabled: agent.enabled }))
  const provider = new NvidiaProvider({
    baseUrl: env.NVIDIA_BASE_URL, apiKey: env.NVIDIA_API_KEY ?? '', model: env.DEFAULT_MODEL, maxOutputTokens: Math.min(1024, Number(env.MAX_OUTPUT_TOKENS ?? 700)), temperature: speaker.temperature ?? 0.7,
    mock: env.ENVIRONMENT !== 'production' && env.MOCK_UPSTREAM === 'true',
  })
  const startedAt = Date.now()
  let streamAborter: AbortController | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false, committed = false, activePermit: string | undefined
      const aborter = new AbortController()
      streamAborter = aborter
      const abort = () => aborter.abort(request.signal.reason)
      request.signal.addEventListener('abort', abort, { once: true })
      const send = (event: StreamEvent): void => { if (!closed) { try { controller.enqueue(streamFrame(event)) } catch { closed = true; aborter.abort() } } }
      const close = (): void => { if (!closed) { closed = true; try { controller.close() } catch { /* client disconnected */ } } }
      void (async () => {
        send({ type: 'queued', requestId: payload.requestId, serverTurnId: begun.serverTurnId, queueState: 'short' })
        let visible = false, fullOutput = '', usage: { inputTokens?: number; outputTokens?: number } | undefined
        try {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const permitResponse = await controlCall(env, '/quota/acquire', { sessionId: session.sessionId, roomId, serverTurnId: begun.serverTurnId, retry: attempt > 0, now: Date.now() }, aborter.signal)
            if (!permitResponse.ok) {
              const error = await permitResponse.json<{ error: { code: ErrorCode; retryable: boolean; retryAfterMs?: number } }>()
              send({ type: 'error', requestId: payload.requestId, serverTurnId: begun.serverTurnId, code: error.error.code, retryable: error.error.retryable, retryAfterMs: error.error.retryAfterMs }); return
            }
            const permit = await permitResponse.json<{ leaseId: string }>(); activePermit = permit.leaseId
            if (attempt === 0) send({ type: 'start', requestId: payload.requestId, serverTurnId: begun.serverTurnId, serverChosenAgentId: begun.speakerId, actualModel: env.DEFAULT_MODEL, protocolTag: PROTOCOL_TAG })
            try {
              const messages = buildPrompt({ topic: payload.topic, agents: payload.agents, messages: payload.messages, speaker })
              for await (const event of provider.streamChat(messages, aborter.signal)) {
                if (event.type === 'content') { visible = true; fullOutput += event.delta; send({ type: 'content', requestId: payload.requestId, serverTurnId: begun.serverTurnId, delta: event.delta }) }
                else usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens }
              }
              const mentions = parseMentions(fullOutput, roster, begun.speakerId)
              const finished = await controlCall(env, '/turn/finish', { sessionId: session.sessionId, roomId, leaseId: begun.leaseId, serverTurnId: begun.serverTurnId, mentions, now: Date.now() })
              if (!finished.ok) { send({ type: 'error', requestId: payload.requestId, serverTurnId: begun.serverTurnId, code: 'SERVICE_ERROR', retryable: false }); return }
              committed = true
              send({ type: 'done', requestId: payload.requestId, serverTurnId: begun.serverTurnId, actualModel: env.DEFAULT_MODEL, durationMs: Date.now() - startedAt, ...(usage ? { usage } : {}) })
              return
            } catch (caught) {
              const error = caught instanceof ProviderError ? caught : new ProviderError('unavailable', undefined, undefined, !visible)
              if (error.kind === 'rate') await controlCall(env, '/quota/cooldown', { until: Date.now() + (error.retryAfterMs ?? 30_000) })
              if (error.kind === 'auth') await controlCall(env, '/provider/kill', {})
              const canRetry = !visible && attempt === 0 && (error.kind === 'transient' || error.kind === 'timeout')
              if (!canRetry) { const mapped = mapProviderError(error); send({ type: 'error', requestId: payload.requestId, serverTurnId: begun.serverTurnId, ...mapped }); return }
            } finally {
              if (activePermit) { await controlCall(env, '/quota/release', { leaseId: activePermit, serverTurnId: begun.serverTurnId }); activePermit = undefined }
            }
          }
        } finally {
          if (!committed) await controlCall(env, '/turn/fail', { sessionId: session.sessionId, roomId, leaseId: begun.leaseId, serverTurnId: begun.serverTurnId, now: Date.now() }).catch(() => undefined)
          request.signal.removeEventListener('abort', abort)
          close()
        }
      })()
    },
    cancel(reason) { streamAborter?.abort(reason) },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no' } })
}

async function routeRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  let response: Response
  if (request.method === 'OPTIONS') {
    response = request.headers.get('origin') === env.PUBLIC_ORIGIN ? new Response(null, { status: 204, headers: { 'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS', 'access-control-allow-headers': 'content-type, x-agentroom-smoke-timestamp, x-agentroom-smoke-signature', 'access-control-max-age': '600' } }) : apiError('INVALID_REQUEST', 403)
    return withSecurity(response, request, env)
  }
  if (url.pathname === '/api/config' && request.method === 'GET') response = await config(env)
  else if (url.pathname.startsWith('/api/')) {
    if (!(await trustedRequest(request, env))) response = apiError('INVALID_REQUEST', 403)
    else if (url.pathname === '/api/session' && request.method === 'POST') response = await createSession(request, env)
    else {
      const session = await requireSession(request, env)
      if (session instanceof Response) response = session
      else if (url.pathname === '/api/rooms/register' && request.method === 'POST') response = await register(request, env, session)
      else {
        const match = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{8,64})\/(control|skip|turn)$/)
        if (!match) response = apiError('INVALID_REQUEST', 404)
        else if (match[2] === 'control' && request.method === 'PATCH') response = await control(request, env, session, match[1])
        else if (match[2] === 'skip' && request.method === 'POST') response = await skip(request, env, session, match[1])
        else if (match[2] === 'turn' && request.method === 'POST') response = await turn(request, env, session, match[1])
        else response = apiError('INVALID_REQUEST', 405)
      }
    }
  } else response = apiError('INVALID_REQUEST', 404)
  return withSecurity(response, request, env)
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  try { return await routeRequest(request, env) }
  catch { return withSecurity(apiError('SERVICE_UNAVAILABLE', 503, undefined, true), request, env) }
}
