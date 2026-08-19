import { describe, expect, it } from 'vitest'
import { transitionControl } from './control-state'
import { initialFairness } from './scheduler'
import type { RoomRecord } from './types'

const roster = [{ agentId: 'agent-0001', nameKey: 'alex', enabled: true }, { agentId: 'agent-0002', nameKey: 'maya', enabled: true }]
const base = (): RoomRecord => ({ roomId: 'room-0001', sessionId: 'session-1', roster, cursorIndex: 0, activeRunId: 'run-00001', runTurnLimit: 12, runTurnsCompleted: 12, totalTurnsCompleted: 12, status: 'finished', lastAcceptedMentions: [], fairness: initialFairness(roster), controlRevision: 4, failedTurns: { old: 'agent-0001' }, expiresAt: 100, updatedAt: 0 })

describe('room control transitions', () => {
  it('continues into a distinct run without resetting room total', () => {
    const next = transitionControl(base(), { action: 'continue', idempotencyKey: 'idem-0001', controlRevision: 4, runId: 'run-00002', turnLimit: 6 }, 1000)
    expect(next).toMatchObject({ activeRunId: 'run-00002', runTurnLimit: 6, runTurnsCompleted: 0, totalTurnsCompleted: 12, status: 'running', controlRevision: 5 })
  })

  it('rejects stale revisions and live leases', () => {
    expect(() => transitionControl(base(), { action: 'pause', idempotencyKey: 'idem-0001', controlRevision: 3 }, 10)).toThrow('REVISION_CONFLICT')
    const busy = base(); busy.activeLease = { leaseId: 'lease', serverTurnId: 'turn', expiresAt: 20 }
    expect(() => transitionControl(busy, { action: 'pause', idempotencyKey: 'idem-0001', controlRevision: 4 }, 10)).toThrow('ROOM_BUSY')
  })
})
