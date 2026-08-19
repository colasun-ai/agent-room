import { describe, expect, it } from 'vitest'
import { PROTOCOL_TAG } from '../shared/protocol'
import { validateTurn } from './validation'

describe('trusted turn validation', () => {
  it('canonicalizes transcript identity labels from validated profiles', () => {
    const payload = validateTurn({
      requestId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
      roomId: 'room-0001', runId: 'run-00001', protocolTag: PROTOCOL_TAG, appBuildId: 'test', topic: 'Topic',
      agents: [
        { id: 'agent-0001', name: 'Alex', normalizedName: 'alex', role: 'PM', avatar: 'A', personality: 'direct', goal: 'ship', enabled: true },
        { id: 'agent-0002', name: 'Maya', normalizedName: 'maya', role: 'Engineer', avatar: 'M', personality: 'careful', goal: 'build', enabled: true },
      ],
      messages: [{ id: 'message-0001', senderType: 'agent', senderId: 'agent-0001', senderName: 'Maya', senderRole: 'Engineer', content: 'Hello', status: 'completed', createdAt: 1 }],
    }, 'room-0001')
    expect(payload.messages[0]).toMatchObject({ senderId: 'agent-0001', senderName: 'Alex', senderRole: 'PM' })
  })
})
