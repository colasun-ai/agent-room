import { describe, expect, it } from 'vitest'
import { advanceAfterCompletion, chooseSpeaker, initialFairness, parseMentions } from './scheduler'
import type { RoomRecord } from './types'

const roster = [
  { agentId: 'agent-0001', nameKey: 'alex', enabled: true },
  { agentId: 'agent-0002', nameKey: 'maya', enabled: true },
  { agentId: 'agent-0003', nameKey: 'nova', enabled: true },
]

function room(): RoomRecord {
  return { roomId: 'room-0001', sessionId: 'session-1', roster, cursorIndex: 0, activeRunId: 'run-00001', runTurnLimit: 12, runTurnsCompleted: 0, totalTurnsCompleted: 0, status: 'running', lastAcceptedMentions: [], fairness: initialFairness(roster), controlRevision: 1, failedTurns: {}, expiresAt: 99_999, updatedAt: 0 }
}

describe('speaker scheduler', () => {
  it('round robins and does not consume the cursor for a boost', () => {
    const state = room()
    expect(chooseSpeaker(state).agentId).toBe('agent-0001')
    state.lastAcceptedMentions = ['nova']
    const boosted = chooseSpeaker(state)
    expect(boosted).toMatchObject({ agentId: 'agent-0003', boosted: true })
    const next = advanceAfterCompletion(state, boosted, [])
    expect(next.cursorIndex).toBe(0)
    expect(chooseSpeaker(next).agentId).toBe('agent-0001')
  })

  it('honors exact leading user address but not unknown names', () => {
    expect(chooseSpeaker(room(), '@Maya: please review')).toMatchObject({ agentId: 'agent-0002', reason: 'user-address' })
    expect(chooseSpeaker(room(), 'Could @Maya review?').agentId).toBe('agent-0001')
  })

  it('caps boosts and guards starvation across mention cycles', () => {
    const state = room()
    state.lastAcceptedMentions = ['maya']
    state.fairness.consecutiveBoosts = 2
    expect(chooseSpeaker(state).reason).toBe('round-robin')
    state.fairness.consecutiveBoosts = 0
    state.fairness.turnsSinceSpoke['agent-0003'] = 10
    expect(chooseSpeaker(state)).toMatchObject({ agentId: 'agent-0003', reason: 'starvation' })
  })
})

describe('mention parser', () => {
  it('accepts enabled exact names, removes self and unknown mentions', () => {
    expect(parseMentions('@Maya please ask @Nova. Ignore @Ghost and @Alex.', roster, 'agent-0001')).toEqual(['maya', 'nova'])
  })
})
