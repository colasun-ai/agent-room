import { DurableObject } from 'cloudflare:workers'
import { advanceAfterCompletion, chooseSpeaker, initialFairness, type SpeakerChoice } from './scheduler'
import { effectiveDailyAttemptLimit, FairQueue, utcDayStart } from './quota'
import { transitionControl } from './control-state'
import type { Env, RoomRecord, TurnBeginRequest, TurnBeginResult } from './types'

type SqlRow = Record<string, SqlStorageValue>
interface AcquirePayload { sessionId: string; roomId: string; serverTurnId: string; retry: boolean; now: number }
interface Waiting { payload: AcquirePayload; resolve: (response: Response) => void; expiresAt: number; aborted: boolean }

const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } })

export class ControlPlane extends DurableObject<Env> {
  private readonly queue = new FairQueue<Waiting>()
  private pumping = false
  private timer?: ReturnType<typeof setTimeout>

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => this.initialize())
  }

  private initialize(): void {
    const sql = this.ctx.storage.sql
    sql.exec(`CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, risk_key TEXT NOT NULL, expires_at INTEGER NOT NULL, idle_expires_at INTEGER NOT NULL, verified_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS risk_events (risk_key TEXT NOT NULL, at INTEGER NOT NULL)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS risk_events_at ON risk_events(risk_key, at)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS rooms (room_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL, expires_at INTEGER NOT NULL)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS rooms_session ON rooms(session_id)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS idempotency (scope TEXT NOT NULL, key TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(scope,key))`)
    sql.exec(`CREATE TABLE IF NOT EXISTS attempts (at INTEGER NOT NULL, session_id TEXT NOT NULL, room_id TEXT NOT NULL)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS attempts_at ON attempts(at)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS attempts_session ON attempts(session_id, at)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS permits (lease_id TEXT PRIMARY KEY, server_turn_id TEXT NOT NULL, session_id TEXT NOT NULL, room_id TEXT NOT NULL, expires_at INTEGER NOT NULL)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS room_pacing (room_id TEXT PRIMARY KEY, last_attempt_at INTEGER NOT NULL)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS challenge_tokens (token_hash TEXT PRIMARY KEY, used_at INTEGER NOT NULL)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS control_events (session_id TEXT NOT NULL, risk_key TEXT NOT NULL, at INTEGER NOT NULL)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS control_events_session ON control_events(session_id, at)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS control_events_risk ON control_events(risk_key, at)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS access_attempts (risk_key TEXT NOT NULL, at INTEGER NOT NULL)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS access_attempts_risk ON access_attempts(risk_key, at)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  }

  private rows(query: string, ...bindings: (string | number | null)[]): SqlRow[] {
    return [...this.ctx.storage.sql.exec<SqlRow>(query, ...bindings)]
  }

  private one(query: string, ...bindings: (string | number | null)[]): SqlRow | undefined {
    return this.rows(query, ...bindings)[0]
  }

  private validSession(sessionId: string, now: number, touch = true): boolean {
    const row = this.one('SELECT expires_at, idle_expires_at, last_seen FROM sessions WHERE session_id = ?', sessionId)
    if (!row || Number(row.expires_at) <= now || Number(row.idle_expires_at) <= now) return false
    if (touch && Number(row.last_seen) <= now - 5 * 60_000) {
      this.ctx.storage.sql.exec('UPDATE sessions SET idle_expires_at = ?, last_seen = ? WHERE session_id = ?', Math.min(Number(row.expires_at), now + 2 * 60 * 60_000), now, sessionId)
    }
    return true
  }

  private readRoom(roomId: string): RoomRecord | undefined {
    const row = this.one('SELECT data, expires_at FROM rooms WHERE room_id = ?', roomId)
    if (!row || Number(row.expires_at) <= Date.now()) return undefined
    return JSON.parse(String(row.data)) as RoomRecord
  }

  private writeRoom(room: RoomRecord): void {
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO rooms(room_id,session_id,data,expires_at) VALUES(?,?,?,?)', room.roomId, room.sessionId, JSON.stringify(room), room.expiresAt)
  }

  private ownedRoom(roomId: string, sessionId: string): RoomRecord | undefined {
    const room = this.readRoom(roomId)
    return room?.sessionId === sessionId ? room : undefined
  }

  private hasOtherRunningRoom(sessionId: string, roomId: string, now: number): boolean {
    return this.rows('SELECT room_id,data,expires_at FROM rooms WHERE session_id=? AND room_id<>? AND expires_at>?', sessionId, roomId, now)
      .some((row) => (JSON.parse(String(row.data)) as RoomRecord).status === 'running')
  }

  private activeTurnIdempotency(scope: string, serverTurnId: string): { key: string; choice?: SpeakerChoice; speakerId?: string } | undefined {
    for (const row of this.rows('SELECT key,data FROM idempotency WHERE scope=? AND status=?', scope, 'active')) {
      const data = JSON.parse(String(row.data)) as { serverTurnId?: string; choice?: SpeakerChoice; speakerId?: string }
      if (data.serverTurnId === serverTurnId) return { key: String(row.key), choice: data.choice, speakerId: data.speakerId }
    }
    return undefined
  }

  private controlWriteGate(sessionId: string, now: number): Response | undefined {
    const session = this.one('SELECT risk_key,verified_until FROM sessions WHERE session_id=?', sessionId)
    if (!session) return this.error('SESSION_EXPIRED', 401)
    const perMinute = Number(this.one('SELECT COUNT(*) count FROM control_events WHERE session_id=? AND at>?', sessionId, now - 60_000)?.count ?? 0)
    const perDay = Number(this.one('SELECT COUNT(*) count FROM control_events WHERE session_id=? AND at>?', sessionId, now - 24 * 60 * 60_000)?.count ?? 0)
    const networkMinute = Number(this.one('SELECT COUNT(*) count FROM control_events WHERE risk_key=? AND at>?', String(session.risk_key), now - 60_000)?.count ?? 0)
    const verified = Number(session.verified_until) > now
    if (perMinute >= (verified ? 60 : 30) || perDay >= (verified ? 1000 : 500) || networkMinute >= 240) {
      return this.error(verified ? 'RATE_LIMITED' : 'CHALLENGE_REQUIRED', verified ? 429 : 403, 60_000)
    }
    this.ctx.storage.sql.exec('INSERT INTO control_events(session_id,risk_key,at) VALUES(?,?,?)', sessionId, String(session.risk_key), now)
    return undefined
  }

  private cleanup(now: number): void {
    const sql = this.ctx.storage.sql
    sql.exec('DELETE FROM attempts WHERE at <= ?', now - 2 * 24 * 60 * 60_000)
    sql.exec('DELETE FROM permits WHERE expires_at <= ?', now)
    sql.exec('DELETE FROM idempotency WHERE expires_at <= ?', now)
    sql.exec('DELETE FROM risk_events WHERE at <= ?', now - 60 * 60_000)
    sql.exec('DELETE FROM sessions WHERE expires_at <= ? OR idle_expires_at <= ?', now, now)
    sql.exec('DELETE FROM rooms WHERE session_id NOT IN (SELECT session_id FROM sessions)')
    sql.exec('DELETE FROM rooms WHERE expires_at <= ?', now)
    sql.exec('DELETE FROM challenge_tokens WHERE used_at <= ?', now - 10 * 60_000)
    sql.exec('DELETE FROM control_events WHERE at <= ?', now - 24 * 60 * 60_000)
    sql.exec('DELETE FROM access_attempts WHERE at <= ?', now - 60 * 60_000)
    sql.exec('DELETE FROM room_pacing WHERE room_id NOT IN (SELECT room_id FROM rooms)')
  }

  private capacityBusy(now: number): boolean {
    const active = Number(this.one('SELECT COUNT(*) count FROM permits WHERE expires_at > ?', now)?.count ?? 0)
    const rpm = Number(this.one('SELECT COUNT(*) count FROM attempts WHERE at > ?', now - 60_000)?.count ?? 0)
    return this.queue.size > 2 || active >= Number(this.env.MAX_CONCURRENT_UPSTREAM || 2) || rpm >= Math.min(28, Number(this.env.OPERATING_UPSTREAM_RPM || 28))
  }

  private error(code: string, status: number, retryAfterMs?: number): Response {
    return json({ error: { code, retryable: code === 'RATE_LIMITED' || code === 'CAPACITY_EXHAUSTED' || code === 'QUEUE_TIMEOUT', retryAfterMs } }, status)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const body = request.method === 'GET' ? {} : await request.json<Record<string, unknown>>().catch(() => ({}))
    try {
      if (url.pathname === '/session/create') return this.createSession(body)
      if (url.pathname === '/access/check') return this.checkAccess(body)
      if (url.pathname === '/session/exists') return this.sessionExists(body)
      if (url.pathname === '/session/verify') return this.verifySession(body)
      if (url.pathname === '/rooms/register') return this.registerRoom(body)
      if (url.pathname === '/rooms/control') return this.controlRoom(body)
      if (url.pathname === '/rooms/skip') return this.skipRoom(body)
      if (url.pathname === '/turn/begin') return this.beginTurn(body as unknown as TurnBeginRequest)
      if (url.pathname === '/turn/finish') return this.finishTurn(body)
      if (url.pathname === '/turn/fail') return this.failTurn(body)
      if (url.pathname === '/turn/cancel') return this.cancelTurn(body)
      if (url.pathname === '/quota/acquire') return this.acquire(request, body as unknown as AcquirePayload)
      if (url.pathname === '/quota/release') return this.releasePermit(body)
      if (url.pathname === '/quota/cooldown') return this.setCooldown(body)
      if (url.pathname === '/provider/kill') return this.killProvider()
      if (url.pathname === '/status') return this.status()
      return json({ error: 'not-found' }, 404)
    } catch {
      return this.error('SERVICE_ERROR', 500)
    }
  }

  private checkAccess(body: Record<string, unknown>): Response {
    const now = Number(body.now), riskKey = String(body.riskKey ?? ''), success = body.success === true
    if (!Number.isFinite(now) || riskKey.length < 16 || riskKey.length > 128) return this.error('INVALID_REQUEST', 400)
    this.ctx.storage.sql.exec('DELETE FROM access_attempts WHERE at <= ?', now - 60 * 60_000)
    const recent = Number(this.one('SELECT COUNT(*) count FROM access_attempts WHERE risk_key = ? AND at > ?', riskKey, now - 15 * 60_000)?.count ?? 0)
    if (recent >= 5) return this.error('RATE_LIMITED', 429, 15 * 60_000)
    if (success) {
      this.ctx.storage.sql.exec('DELETE FROM access_attempts WHERE risk_key = ?', riskKey)
      return json({ allowed: true })
    }
    this.ctx.storage.sql.exec('INSERT INTO access_attempts(risk_key,at) VALUES(?,?)', riskKey, now)
    return recent >= 4 ? this.error('RATE_LIMITED', 429, 15 * 60_000) : this.error('ACCESS_REQUIRED', 401)
  }

  private createSession(body: Record<string, unknown>): Response {
    const now = Number(body.now)
    const riskKey = String(body.riskKey ?? '')
    const sessionId = String(body.sessionId ?? '')
    this.cleanup(now)
    const recent = Number(this.one('SELECT COUNT(*) count FROM risk_events WHERE risk_key = ? AND at > ?', riskKey, now - 10 * 60_000)?.count ?? 0)
    const challengeHash = typeof body.challengeHash === 'string' ? body.challengeHash : undefined
    const accessVerified = body.accessVerified === true
    if (recent >= 3 && !challengeHash && !accessVerified) return this.error('CHALLENGE_REQUIRED', 403)
    if (challengeHash) {
      if (this.one('SELECT token_hash FROM challenge_tokens WHERE token_hash = ?', challengeHash)) return this.error('CHALLENGE_REQUIRED', 403)
      this.ctx.storage.sql.exec('INSERT INTO challenge_tokens(token_hash,used_at) VALUES(?,?)', challengeHash, now)
    }
    this.ctx.storage.sql.exec('INSERT INTO risk_events(risk_key,at) VALUES(?,?)', riskKey, now)
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO sessions(session_id,risk_key,expires_at,idle_expires_at,verified_until,created_at,last_seen) VALUES(?,?,?,?,?,?,?)', sessionId, riskKey, Number(body.expiresAt), Number(body.idleExpiresAt), challengeHash || accessVerified ? now + 60 * 60_000 : 0, now, now)
    return json({ ok: true })
  }

  private sessionExists(body: Record<string, unknown>): Response {
    return this.validSession(String(body.sessionId ?? ''), Number(body.now), false) ? json({ exists: true }) : this.error('SESSION_EXPIRED', 401)
  }

  private verifySession(body: Record<string, unknown>): Response {
    const sessionId = String(body.sessionId ?? ''), challengeHash = String(body.challengeHash ?? ''), now = Number(body.now)
    if (!this.validSession(sessionId, now) || !challengeHash) return this.error('SESSION_EXPIRED', 401)
    if (this.one('SELECT token_hash FROM challenge_tokens WHERE token_hash=?', challengeHash)) return this.error('CHALLENGE_REQUIRED', 403)
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('INSERT INTO challenge_tokens(token_hash,used_at) VALUES(?,?)', challengeHash, now)
      this.ctx.storage.sql.exec('UPDATE sessions SET verified_until=? WHERE session_id=?', now + 60 * 60_000, sessionId)
    })
    return json({ ok: true, verifiedUntil: now + 60 * 60_000 })
  }

  private registerRoom(body: Record<string, unknown>): Response {
    const sessionId = String(body.sessionId)
    const now = Number(body.now)
    if (!this.validSession(sessionId, now)) return this.error('SESSION_EXPIRED', 401)
    const existing = this.readRoom(String(body.roomId))
    if (existing && existing.sessionId !== sessionId) return this.error('ROOM_NOT_REGISTERED', 404)
    if (existing) return json({ roomId: existing.roomId, runId: existing.activeRunId, controlRevision: existing.controlRevision, expiresAt: existing.expiresAt })
    const roomCount = Number(this.one('SELECT COUNT(*) count FROM rooms WHERE session_id=? AND expires_at>?', sessionId, now)?.count ?? 0)
    if (roomCount >= 20) return this.error('RATE_LIMITED', 429, 60_000)
    const writeGate = this.controlWriteGate(sessionId, now)
    if (writeGate) return writeGate
    if (this.hasOtherRunningRoom(sessionId, String(body.roomId), now)) return this.error('ROOM_BUSY', 409)
    const roster = body.roster as RoomRecord['roster']
    const room: RoomRecord = {
      roomId: String(body.roomId), sessionId, roster, cursorIndex: 0, activeRunId: String(body.runId), runTurnLimit: Number(body.turnLimit), runTurnsCompleted: Number(body.runTurnsCompleted ?? 0),
      totalTurnsCompleted: Number(body.totalTurnsCompleted ?? 0), status: String(body.status ?? 'running') as RoomRecord['status'], lastAcceptedMentions: [], fairness: initialFairness(roster), controlRevision: 1, failedTurns: {}, expiresAt: now + 12 * 60 * 60_000, updatedAt: now,
    }
    this.writeRoom(room)
    return json({ roomId: room.roomId, runId: room.activeRunId, controlRevision: room.controlRevision, expiresAt: room.expiresAt })
  }

  private controlRoom(body: Record<string, unknown>): Response {
    const sessionId = String(body.sessionId), roomId = String(body.roomId), now = Number(body.now)
    if (!this.validSession(sessionId, now)) return this.error('SESSION_EXPIRED', 401)
    const room = this.ownedRoom(roomId, sessionId)
    if (!room) return this.error('ROOM_NOT_REGISTERED', 404)
    const key = String(body.idempotencyKey), scope = `${sessionId}:${roomId}:control`
    const cached = this.one('SELECT data FROM idempotency WHERE scope=? AND key=? AND expires_at>?', scope, key, now)
    if (cached) return json(JSON.parse(String(cached.data)))
    const writeGate = this.controlWriteGate(sessionId, now)
    if (writeGate) return writeGate
    if (Number(body.controlRevision) !== room.controlRevision) return this.error('INVALID_REQUEST', 409)
    if (body.action !== 'pause' && room.activeLease && room.activeLease.expiresAt > now) return this.error('ROOM_BUSY', 409)
    if ((body.action === 'resume' || body.action === 'continue') && this.hasOtherRunningRoom(sessionId, roomId, now)) return this.error('ROOM_BUSY', 409)
    let updated: RoomRecord
    try { updated = transitionControl(room, body as never, now) }
    catch (error) {
      const message = error instanceof Error ? error.message : ''
      return this.error(message === 'ROOM_BUSY' ? 'ROOM_BUSY' : message === 'RUN_COMPLETE' ? 'RUN_COMPLETE' : 'INVALID_REQUEST', 409)
    }
    const result = { controlRevision: updated.controlRevision, runId: updated.activeRunId, status: updated.status }
    this.ctx.storage.transactionSync(() => {
      this.writeRoom(updated)
      this.ctx.storage.sql.exec('INSERT INTO idempotency(scope,key,status,data,expires_at) VALUES(?,?,?,?,?)', scope, key, 'done', JSON.stringify(result), now + 20 * 60_000)
    })
    return json(result)
  }

  private skipRoom(body: Record<string, unknown>): Response {
    const sessionId = String(body.sessionId), roomId = String(body.roomId), now = Number(body.now), key = String(body.idempotencyKey)
    if (!this.validSession(sessionId, now)) return this.error('SESSION_EXPIRED', 401)
    const room = this.ownedRoom(roomId, sessionId)
    if (!room) return this.error('ROOM_NOT_REGISTERED', 404)
    const scope = `${sessionId}:${roomId}:skip`, cached = this.one('SELECT data FROM idempotency WHERE scope=? AND key=? AND expires_at>?', scope, key, now)
    if (cached) return json(JSON.parse(String(cached.data)))
    const writeGate = this.controlWriteGate(sessionId, now)
    if (writeGate) return writeGate
    if (Number(body.controlRevision) !== room.controlRevision) return this.error('INVALID_REQUEST', 409)
    if (room.status !== 'running') return this.error(room.status === 'finished' ? 'RUN_COMPLETE' : 'ROOM_BUSY', 409)
    if (room.activeLease && room.activeLease.expiresAt > now) return this.error('ROOM_BUSY', 409)
    const failedSpeaker = typeof body.serverTurnId === 'string' ? room.failedTurns[body.serverTurnId] : undefined
    if (body.serverTurnId && !failedSpeaker) return this.error('INVALID_REQUEST', 400)
    const choice = chooseSpeaker(room, typeof body.latestUserDirectAddress === 'string' ? body.latestUserDirectAddress : undefined, failedSpeaker)
    const updated = advanceAfterCompletion(room, choice, [])
    updated.failedTurns = {}
    updated.updatedAt = now; updated.expiresAt = now + 12 * 60 * 60_000
    const result = { skippedAgentId: choice.agentId, controlRevision: updated.controlRevision, runTurnsCompleted: updated.runTurnsCompleted, totalTurnsCompleted: updated.totalTurnsCompleted }
    this.ctx.storage.transactionSync(() => {
      this.writeRoom(updated)
      this.ctx.storage.sql.exec('INSERT INTO idempotency(scope,key,status,data,expires_at) VALUES(?,?,?,?,?)', scope, key, 'done', JSON.stringify(result), now + 20 * 60_000)
    })
    return json(result)
  }

  private beginTurn(body: TurnBeginRequest): Response {
    const { sessionId, roomId, now, idempotencyKey } = body
    if (!this.validSession(sessionId, now)) return this.error('SESSION_EXPIRED', 401)
    const room = this.ownedRoom(roomId, sessionId)
    if (!room) return this.error('ROOM_NOT_REGISTERED', 404)
    const scope = `${sessionId}:${roomId}:turn`
    const cached = this.one('SELECT data,status FROM idempotency WHERE scope=? AND key=? AND expires_at>?', scope, idempotencyKey, now)
    if (cached) return this.error('ROOM_BUSY', 409)
    if (body.runId !== room.activeRunId) return this.error('INVALID_REQUEST', 409)
    if (room.runTurnsCompleted >= room.runTurnLimit || room.status === 'finished') return this.error('RUN_COMPLETE', 409)
    if (room.status !== 'running') return this.error('ROOM_BUSY', 409)
    if (this.hasOtherRunningRoom(sessionId, roomId, now)) return this.error('ROOM_BUSY', 409)
    if (room.activeLease && room.activeLease.expiresAt > now) return this.error('ROOM_BUSY', 409)
    if (room.activeLease && room.activeLease.expiresAt <= now) {
      this.ctx.storage.sql.exec('UPDATE idempotency SET status=? WHERE scope=? AND status=?', 'error', scope, 'active')
      room.activeLease = undefined
    }
    const retrySpeaker = body.retryOfServerTurnId ? room.failedTurns[body.retryOfServerTurnId] : undefined
    if (body.retryOfServerTurnId && !retrySpeaker) return this.error('INVALID_REQUEST', 400)
    const choice = chooseSpeaker(room, body.latestUserDirectAddress, retrySpeaker)
    const speakerNameKey = room.roster.find((entry) => entry.agentId === choice.agentId)!.nameKey
    const result: TurnBeginResult & { choice: SpeakerChoice } = { serverTurnId: crypto.randomUUID(), leaseId: crypto.randomUUID(), speakerId: choice.agentId, speakerNameKey, boosted: choice.boosted, queueState: this.capacityBusy(now) ? 'busy' : 'short', expiresAt: now + 240_000, choice }
    room.activeLease = { leaseId: result.leaseId, serverTurnId: result.serverTurnId, expiresAt: result.expiresAt }; room.updatedAt = now
    this.ctx.storage.transactionSync(() => {
      this.writeRoom(room)
      this.ctx.storage.sql.exec('INSERT INTO idempotency(scope,key,status,data,expires_at) VALUES(?,?,?,?,?)', scope, idempotencyKey, 'active', JSON.stringify(result), now + 20 * 60_000)
    })
    return json(result)
  }

  private finishTurn(body: Record<string, unknown>): Response {
    const room = this.ownedRoom(String(body.roomId), String(body.sessionId)), now = Number(body.now)
    if (!room) return this.error('ROOM_NOT_REGISTERED', 404)
    if (!room.activeLease || room.activeLease.leaseId !== body.leaseId || room.activeLease.serverTurnId !== body.serverTurnId) return this.error('ROOM_BUSY', 409)
    const scope = `${room.sessionId}:${room.roomId}:turn`
    const idem = this.activeTurnIdempotency(scope, String(body.serverTurnId))
    if (!idem?.choice) return this.error('SERVICE_ERROR', 500)
    const updated = advanceAfterCompletion(room, idem.choice, Array.isArray(body.mentions) ? body.mentions.map(String) : [])
    updated.updatedAt = now; updated.expiresAt = now + 12 * 60 * 60_000; updated.failedTurns = {}
    const result = { controlRevision: updated.controlRevision, runTurnsCompleted: updated.runTurnsCompleted, totalTurnsCompleted: updated.totalTurnsCompleted }
    this.ctx.storage.transactionSync(() => {
      this.writeRoom(updated)
      this.ctx.storage.sql.exec('UPDATE idempotency SET status=?,data=? WHERE scope=? AND key=?', 'done', JSON.stringify(result), scope, idem.key)
    })
    return json(result)
  }

  private failTurn(body: Record<string, unknown>): Response {
    const room = this.ownedRoom(String(body.roomId), String(body.sessionId))
    if (!room) return this.error('ROOM_NOT_REGISTERED', 404)
    const activeLease = room.activeLease
    if (activeLease && activeLease.leaseId === body.leaseId && activeLease.serverTurnId === body.serverTurnId) {
      const scope = `${room.sessionId}:${room.roomId}:turn`
      const idem = this.activeTurnIdempotency(scope, String(body.serverTurnId))
      if (idem?.speakerId) room.failedTurns[String(body.serverTurnId)] = idem.speakerId
      room.activeLease = undefined; room.updatedAt = Number(body.now)
      this.ctx.storage.transactionSync(() => {
        this.writeRoom(room)
        if (idem) this.ctx.storage.sql.exec('UPDATE idempotency SET status=? WHERE scope=? AND key=?', 'error', scope, idem.key)
      })
    }
    return json({ ok: true })
  }

  private cancelTurn(body: Record<string, unknown>): Response {
    const sessionId = String(body.sessionId), roomId = String(body.roomId), serverTurnId = String(body.serverTurnId), now = Number(body.now)
    if (!this.validSession(sessionId, now)) return this.error('SESSION_EXPIRED', 401)
    const room = this.ownedRoom(roomId, sessionId)
    if (!room) return this.error('ROOM_NOT_REGISTERED', 404)
    if (!room.activeLease) return json({ ok: true, cancelled: false }, 200, { 'x-agentroom-cancelled': '0' })
    if (room.activeLease.serverTurnId !== serverTurnId) return this.error('INVALID_REQUEST', 409)
    const scope = `${sessionId}:${roomId}:turn`
    const idem = this.activeTurnIdempotency(scope, serverTurnId)
    if (idem?.speakerId) room.failedTurns[serverTurnId] = idem.speakerId
    room.activeLease = undefined; room.updatedAt = now
    this.ctx.storage.transactionSync(() => {
      this.writeRoom(room)
      if (idem) this.ctx.storage.sql.exec('UPDATE idempotency SET status=? WHERE scope=? AND key=?', 'error', scope, idem.key)
      this.ctx.storage.sql.exec('DELETE FROM permits WHERE session_id=? AND room_id=? AND server_turn_id=?', sessionId, roomId, serverTurnId)
    })
    const waiting = this.queue.removeWhere((ticket) => ticket.sessionId === sessionId && ticket.roomId === roomId && ticket.value.payload.serverTurnId === serverTurnId)
    for (const ticket of waiting) { ticket.value.aborted = true; ticket.value.resolve(this.error('REQUEST_ABORTED', 499)) }
    this.schedulePump(0)
    return json({ ok: true, cancelled: true }, 200, { 'x-agentroom-cancelled': '1' })
  }

  private acquire(request: Request, payload: AcquirePayload): Promise<Response> | Response {
    if (!this.validSession(payload.sessionId, payload.now)) return this.error('SESSION_EXPIRED', 401)
    if (this.hasOtherRunningRoom(payload.sessionId, payload.roomId, payload.now)) return this.error('ROOM_BUSY', 409)
    return new Promise<Response>((resolve) => {
      const waiting: Waiting = { payload, resolve, expiresAt: Date.now() + 40_000, aborted: false }
      const ticketId = crypto.randomUUID()
      this.queue.enqueue({ id: ticketId, sessionId: payload.sessionId, roomId: payload.roomId, value: waiting })
      request.signal.addEventListener('abort', () => { waiting.aborted = true; this.queue.remove(ticketId); resolve(this.error('REQUEST_ABORTED', 499)) }, { once: true })
      this.schedulePump(0)
    })
  }

  private schedulePump(delay: number): void {
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.pump() }, delay)
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      const rounds = this.queue.size
      let earliestRetry = 1000
      for (let i = 0; i < rounds; i += 1) {
        const ticket = this.queue.dequeue()
        if (!ticket) break
        const waiting = ticket.value
        if (waiting.aborted) continue
        const now = Date.now()
        if (waiting.expiresAt <= now) { waiting.resolve(this.error('QUEUE_TIMEOUT', 503)); continue }
        const result = this.tryReserve(waiting.payload, now)
        if (result.granted) waiting.resolve(json({ leaseId: result.leaseId, expiresAt: result.expiresAt, queueState: rounds > 2 ? 'busy' : 'short' }))
        else if (result.terminal) waiting.resolve(this.error(result.code!, result.status!, result.retryAfterMs))
        else { this.queue.enqueue(ticket); earliestRetry = Math.min(earliestRetry, result.retryAfterMs ?? 250) }
      }
      if (this.queue.size > 0) this.schedulePump(Math.max(20, earliestRetry))
    } finally { this.pumping = false }
  }

  private tryReserve(payload: AcquirePayload, now: number): { granted: boolean; leaseId?: string; expiresAt?: number; terminal?: boolean; code?: string; status?: number; retryAfterMs?: number } {
    this.cleanup(now)
    const room = this.ownedRoom(payload.roomId, payload.sessionId)
    if (!this.validSession(payload.sessionId, now, false) || !room?.activeLease || room.activeLease.serverTurnId !== payload.serverTurnId) {
      return { granted: false, terminal: true, code: 'REQUEST_ABORTED', status: 499 }
    }
    const killed = this.one("SELECT value FROM meta WHERE key='provider_killed'")?.value === '1'
    if (killed) return { granted: false, terminal: true, code: 'SERVICE_DISABLED', status: 503 }
    const cooldown = Number(this.one("SELECT value FROM meta WHERE key='cooldown_until'")?.value ?? 0)
    if (cooldown > now) return { granted: false, terminal: true, code: 'UPSTREAM_RATE_LIMITED', status: 429, retryAfterMs: cooldown - now }
    const day = utcDayStart(now), daily = Number(this.one('SELECT COUNT(*) count FROM attempts WHERE at >= ?', day)?.count ?? 0)
    const dailyLimit = effectiveDailyAttemptLimit(Number(this.env.GLOBAL_DAILY_ATTEMPT_LIMIT ?? 24_000), this.env.EFFECTIVE_DAILY_ATTEMPT_LIMIT === undefined ? undefined : Number(this.env.EFFECTIVE_DAILY_ATTEMPT_LIMIT))
    if (daily >= dailyLimit) return { granted: false, terminal: true, code: 'DAILY_CAPACITY_EXHAUSTED', status: 503 }
    const active = Number(this.one('SELECT COUNT(*) count FROM permits WHERE expires_at > ?', now)?.count ?? 0)
    if (active >= Number(this.env.MAX_CONCURRENT_UPSTREAM || 2)) return { granted: false, retryAfterMs: 100 }
    const rpm = Number(this.one('SELECT COUNT(*) count FROM attempts WHERE at > ?', now - 60_000)?.count ?? 0)
    const rpmLimit = Math.min(28, Number(this.env.OPERATING_UPSTREAM_RPM || 28))
    if (rpm >= rpmLimit) {
      const oldest = Number(this.one('SELECT MIN(at) at FROM attempts WHERE at > ?', now - 60_000)?.at ?? now)
      return { granted: false, retryAfterMs: Math.max(20, oldest + 60_001 - now) }
    }
    const session = this.one('SELECT verified_until FROM sessions WHERE session_id=?', payload.sessionId)
    const minuteLimit = Number(session?.verified_until ?? 0) > now ? 16 : 10
    const hourLimit = Number(session?.verified_until ?? 0) > now ? 120 : 80
    const minute = Number(this.one('SELECT COUNT(*) count FROM attempts WHERE session_id=? AND at>?', payload.sessionId, now - 60_000)?.count ?? 0)
    const hour = Number(this.one('SELECT COUNT(*) count FROM attempts WHERE session_id=? AND at>?', payload.sessionId, now - 60 * 60_000)?.count ?? 0)
    if (minute >= minuteLimit || hour >= hourLimit) return { granted: false, terminal: true, code: 'RATE_LIMITED', status: 429, retryAfterMs: 60_000 }
    const lastRoom = Number(this.one('SELECT last_attempt_at FROM room_pacing WHERE room_id=?', payload.roomId)?.last_attempt_at ?? 0)
    if (!payload.retry && lastRoom + 3000 > now) return { granted: false, retryAfterMs: lastRoom + 3000 - now }
    const leaseId = crypto.randomUUID(), expiresAt = now + 100_000
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('INSERT INTO attempts(at,session_id,room_id) VALUES(?,?,?)', now, payload.sessionId, payload.roomId)
      this.ctx.storage.sql.exec('INSERT INTO permits(lease_id,server_turn_id,session_id,room_id,expires_at) VALUES(?,?,?,?,?)', leaseId, payload.serverTurnId, payload.sessionId, payload.roomId, expiresAt)
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO room_pacing(room_id,last_attempt_at) VALUES(?,?)', payload.roomId, now)
    })
    return { granted: true, leaseId, expiresAt }
  }

  private releasePermit(body: Record<string, unknown>): Response {
    this.ctx.storage.sql.exec('DELETE FROM permits WHERE lease_id=? AND server_turn_id=?', String(body.leaseId), String(body.serverTurnId))
    this.schedulePump(0)
    return json({ ok: true })
  }

  private setCooldown(body: Record<string, unknown>): Response {
    const now = Date.now()
    const current = Number(this.one("SELECT value FROM meta WHERE key='cooldown_until'")?.value ?? 0)
    const candidate = Number(body.until)
    const requested = Number.isFinite(candidate) ? Math.max(now + 5_000, candidate) : now + 30_000
    const until = Math.max(current, requested)
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta(key,value) VALUES('cooldown_until',?)", String(until))
    return json({ ok: true, until })
  }

  private killProvider(): Response {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta(key,value) VALUES('provider_killed','1')")
    return json({ ok: true })
  }

  private status(): Response {
    const now = Date.now(), cooldown = Number(this.one("SELECT value FROM meta WHERE key='cooldown_until'")?.value ?? 0)
    const killed = this.one("SELECT value FROM meta WHERE key='provider_killed'")?.value === '1'
    const daily = Number(this.one('SELECT COUNT(*) count FROM attempts WHERE at >= ?', utcDayStart(now))?.count ?? 0)
    const dailyLimit = effectiveDailyAttemptLimit(Number(this.env.GLOBAL_DAILY_ATTEMPT_LIMIT ?? 24_000), this.env.EFFECTIVE_DAILY_ATTEMPT_LIMIT === undefined ? undefined : Number(this.env.EFFECTIVE_DAILY_ATTEMPT_LIMIT))
    return json({ killed, cooldown: cooldown > now, dailyExhausted: daily >= dailyLimit, busy: this.capacityBusy(now) })
  }
}
