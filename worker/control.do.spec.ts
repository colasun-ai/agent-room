/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'
import { abortAllDurableObjects, reset, runInDurableObject } from 'cloudflare:test'
import type { ControlPlane } from './control'

type Json = Record<string, unknown>
const namespace = (env as unknown as { CONTROL_PLANE: DurableObjectNamespace<ControlPlane> }).CONTROL_PLANE

function newStub() {
  return namespace.get(namespace.idFromName(crypto.randomUUID()))
}

async function post(stub: DurableObjectStub<ControlPlane>, path: string, body: Json) {
  return stub.fetch(`https://control.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

function session(now: number, sessionId = 'session-0001') {
  return { sessionId, riskKey: 'risk-0001', now, expiresAt: now + 24 * 60 * 60_000, idleExpiresAt: now + 2 * 60 * 60_000 }
}

const roster = [
  { agentId: 'agent-0001', nameKey: 'alex', enabled: true },
  { agentId: 'agent-0002', nameKey: 'maya', enabled: true },
]

afterEach(() => reset())

describe('SQLite ControlPlane integration', () => {
  it('enforces one running room per session and persists the gate across eviction', async () => {
    const id = namespace.idFromName(crypto.randomUUID()), stub = namespace.get(id), now = Date.now()
    expect((await post(stub, '/session/create', session(now))).status).toBe(200)
    expect((await post(stub, '/rooms/register', { sessionId: 'session-0001', roomId: 'room-0001', runId: 'run-00001', turnLimit: 6, roster, now })).status).toBe(200)
    expect((await post(stub, '/rooms/register', { sessionId: 'session-0001', roomId: 'room-0002', runId: 'run-00002', turnLimit: 6, roster, now })).status).toBe(409)
    expect((await post(stub, '/rooms/control', { sessionId: 'session-0001', roomId: 'room-0001', action: 'pause', idempotencyKey: 'pause-0001', controlRevision: 1, now })).status).toBe(200)
    await abortAllDurableObjects()
    const recovered = namespace.get(id)
    expect((await post(recovered, '/rooms/register', { sessionId: 'session-0001', roomId: 'room-0002', runId: 'run-00002', turnLimit: 6, roster, now: now + 1 })).status).toBe(200)
  })

  it('binds finish to the current server turn after an expired lease', async () => {
    const stub = newStub(), now = Date.now()
    await post(stub, '/session/create', session(now))
    await post(stub, '/rooms/register', { sessionId: 'session-0001', roomId: 'room-0001', runId: 'run-00001', turnLimit: 6, roster, now })
    const first = await (await post(stub, '/turn/begin', { sessionId: 'session-0001', requestId: 'request-0001', idempotencyKey: 'turn-key-0001', roomId: 'room-0001', runId: 'run-00001', now })).json<Json>()
    const secondNow = now + 240_001
    const second = await (await post(stub, '/turn/begin', { sessionId: 'session-0001', requestId: 'request-0002', idempotencyKey: 'turn-key-0002', roomId: 'room-0001', runId: 'run-00001', now: secondNow })).json<Json>()
    expect(second.serverTurnId).not.toBe(first.serverTurnId)
    const finished = await post(stub, '/turn/finish', { sessionId: 'session-0001', roomId: 'room-0001', leaseId: second.leaseId, serverTurnId: second.serverTurnId, mentions: [], now: secondNow + 1 })
    await expect(finished.json()).resolves.toMatchObject({ controlRevision: 2, runTurnsCompleted: 1, totalTurnsCompleted: 1 })
    const states = await runInDurableObject(stub, (_instance, state) => [...state.storage.sql.exec<{ key: string; status: string }>('SELECT key,status FROM idempotency ORDER BY key')])
    expect(states).toEqual([{ key: 'turn-key-0001', status: 'error' }, { key: 'turn-key-0002', status: 'done' }])
  })

  it('records pause during a live turn and retains it after completion', async () => {
    const stub = newStub(), now = Date.now()
    await post(stub, '/session/create', session(now))
    await post(stub, '/rooms/register', { sessionId: 'session-0001', roomId: 'room-0001', runId: 'run-00001', turnLimit: 6, roster, now })
    const begun = await (await post(stub, '/turn/begin', { sessionId: 'session-0001', requestId: 'request-0001', idempotencyKey: 'turn-key-0001', roomId: 'room-0001', runId: 'run-00001', now })).json<Json>()
    await expect(post(stub, '/rooms/control', { sessionId: 'session-0001', roomId: 'room-0001', action: 'pause', idempotencyKey: 'pause-0001', controlRevision: 1, now: now + 1 })).resolves.toMatchObject({ status: 200 })
    const finished = await post(stub, '/turn/finish', { sessionId: 'session-0001', roomId: 'room-0001', leaseId: begun.leaseId, serverTurnId: begun.serverTurnId, mentions: [], now: now + 2 })
    await expect(finished.json()).resolves.toMatchObject({ controlRevision: 3, runTurnsCompleted: 1 })
    const stored = await runInDurableObject(stub, (_instance, state) => [...state.storage.sql.exec<{ data: string }>('SELECT data FROM rooms WHERE room_id=?', 'room-0001')][0])
    const room = JSON.parse(stored.data) as Json
    expect(room).toMatchObject({ status: 'paused' })
    expect(room).not.toHaveProperty('activeLease')
  })

  it('retries a pre-token failure with the same speaker and advances only on success', async () => {
    const stub = newStub(), now = Date.now()
    await post(stub, '/session/create', session(now))
    await post(stub, '/rooms/register', { sessionId: 'session-0001', roomId: 'room-0001', runId: 'run-00001', turnLimit: 6, roster, now })
    const first = await (await post(stub, '/turn/begin', { sessionId: 'session-0001', requestId: 'request-0001', idempotencyKey: 'turn-key-0001', roomId: 'room-0001', runId: 'run-00001', now })).json<Json>()
    await post(stub, '/turn/fail', { sessionId: 'session-0001', roomId: 'room-0001', leaseId: first.leaseId, serverTurnId: first.serverTurnId, now: now + 1 })
    const afterFailure = await runInDurableObject(stub, (_instance, state) => JSON.parse([...state.storage.sql.exec<{ data: string }>('SELECT data FROM rooms WHERE room_id=?', 'room-0001')][0].data) as Json)
    expect(afterFailure).toMatchObject({ cursorIndex: 0, runTurnsCompleted: 0, totalTurnsCompleted: 0 })
    const retried = await (await post(stub, '/turn/begin', { sessionId: 'session-0001', requestId: 'request-0002', idempotencyKey: 'turn-key-0002', roomId: 'room-0001', runId: 'run-00001', retryOfServerTurnId: first.serverTurnId, now: now + 2 })).json<Json>()
    expect(retried.speakerId).toBe(first.speakerId)
    const finished = await post(stub, '/turn/finish', { sessionId: 'session-0001', roomId: 'room-0001', leaseId: retried.leaseId, serverTurnId: retried.serverTurnId, mentions: [], now: now + 3 })
    await expect(finished.json()).resolves.toMatchObject({ runTurnsCompleted: 1, totalTurnsCompleted: 1 })
  })

  it('never shortens cooldown and retains it after Durable Object eviction', async () => {
    const id = namespace.idFromName(crypto.randomUUID()), stub = namespace.get(id), now = Date.now(), longUntil = now + 60 * 60_000
    await post(stub, '/quota/cooldown', { until: longUntil })
    await post(stub, '/quota/cooldown', { until: now + 5_000 })
    expect(await runInDurableObject(stub, (_instance, state) => Number([...state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='cooldown_until'")][0].value))).toBe(longUntil)
    await abortAllDurableObjects()
    await expect((await namespace.get(id).fetch('https://control.test/status')).json()).resolves.toMatchObject({ cooldown: true })
  })

  it('rejects challenge replay and physically cleans expired control metadata', async () => {
    const stub = newStub(), now = Date.now()
    await post(stub, '/session/create', { ...session(now), challengeHash: 'challenge-0001' })
    expect((await post(stub, '/session/exists', { sessionId: 'session-0001', now })).status).toBe(200)
    expect((await post(stub, '/session/verify', { sessionId: 'session-0001', challengeHash: 'challenge-0001', now })).status).toBe(403)
    const afterIdleExpiry = now + 2 * 60 * 60_000 + 1
    expect((await post(stub, '/session/exists', { sessionId: 'session-0001', now: afterIdleExpiry })).status).toBe(401)
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('INSERT INTO rooms(room_id,session_id,data,expires_at) VALUES(?,?,?,?)', 'expired-room', 'session-0001', '{}', now - 1)
      state.storage.sql.exec('INSERT INTO room_pacing(room_id,last_attempt_at) VALUES(?,?)', 'expired-room', now - 10_000)
      state.storage.sql.exec('INSERT INTO challenge_tokens(token_hash,used_at) VALUES(?,?)', 'expired-token', now - 11 * 60_000)
    })
    await post(stub, '/session/create', session(afterIdleExpiry, 'session-0002'))
    const remaining = await runInDurableObject(stub, (_instance, state) => ({
      rooms: [...state.storage.sql.exec('SELECT room_id FROM rooms WHERE room_id=?', 'expired-room')].length,
      pacing: [...state.storage.sql.exec('SELECT room_id FROM room_pacing WHERE room_id=?', 'expired-room')].length,
      tokens: [...state.storage.sql.exec('SELECT token_hash FROM challenge_tokens WHERE token_hash=?', 'expired-token')].length,
      oldSession: [...state.storage.sql.exec('SELECT session_id FROM sessions WHERE session_id=?', 'session-0001')].length,
    }))
    expect(remaining).toEqual({ rooms: 0, pacing: 0, tokens: 0, oldSession: 0 })
  })
})
