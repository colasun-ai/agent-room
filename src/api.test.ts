import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_TAG, type TurnRequest } from '../shared/protocol'
import { AgentRoomApiError, streamTurn } from './api'

const request: TurnRequest = {
  requestId: '11111111-1111-4111-8111-111111111111', idempotencyKey: '22222222-2222-4222-8222-222222222222',
  roomId: 'room', runId: 'run', protocolTag: PROTOCOL_TAG, appBuildId: 'test', topic: 'Topic', agents: [], messages: [],
}

function streamResponse(blocks: string[], contentType = 'text/event-stream') {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({ start(controller) { blocks.forEach((block) => controller.enqueue(encoder.encode(block))); controller.close() } }), { headers: { 'content-type': contentType } })
}

afterEach(() => vi.unstubAllGlobals())

describe('turn stream protocol', () => {
  it('maps queued/start/content/done in transport order', async () => {
    const id = request.requestId
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      `event: queued\ndata: ${JSON.stringify({ type: 'queued', requestId: id, serverTurnId: 'st-1', queueState: 'short' })}\n\n`,
      `event: start\ndata: ${JSON.stringify({ type: 'start', requestId: id, serverTurnId: 'st-1', serverChosenAgentId: 'maya', actualModel: 'server-model', protocolTag: PROTOCOL_TAG })}\n\n`,
      `event: content\ndata: ${JSON.stringify({ type: 'content', requestId: id, serverTurnId: 'st-1', delta: 'Hi' })}\n\n`,
      `event: done\ndata: ${JSON.stringify({ type: 'done', requestId: id, serverTurnId: 'st-1', actualModel: 'server-model', durationMs: 12 })}\n\n`,
    ])))
    const types: string[] = []
    await streamTurn('room', request, new AbortController().signal, (event) => { types.push(event.type) })
    expect(types).toEqual(['queued', 'start', 'content', 'done'])
    expect(fetch).toHaveBeenCalledWith('/api/rooms/room/turn', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }))
  })

  it('rejects an unknown event instead of silently interpreting it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([`${JSON.stringify({ type: 'thinking', requestId: request.requestId })}\n`], 'application/x-ndjson')))
    await expect(streamTurn('room', request, new AbortController().signal, () => undefined)).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' } satisfies Partial<AgentRoomApiError>)
  })

  it('rejects a start event with an incompatible protocol tag', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([`data: ${JSON.stringify({ type: 'start', requestId: request.requestId, serverTurnId: 'st', serverChosenAgentId: 'maya', actualModel: 'x', protocolTag: 'old' })}\n\n`])))
    await expect(streamTurn('room', request, new AbortController().signal, () => undefined)).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
  })
})
