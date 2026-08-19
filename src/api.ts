import { PROTOCOL_TAG, type ApiError, type ControlAction, type PublicConfig, type RegisterRoomRequest, type RegisterRoomResponse, type StreamEvent, type TurnRequest } from '../shared/protocol'

export class AgentRoomApiError extends Error {
  constructor(public code: string, message: string, public retryable = false, public retryAfterMs?: number) { super(message) }
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'same-origin', headers: { 'content-type': 'application/json', ...init?.headers } })
  if (!response.ok) {
    let body: ApiError | undefined
    try { body = await response.json() as ApiError } catch { /* stable fallback */ }
    throw new AgentRoomApiError(body?.error.code ?? 'SERVICE_ERROR', body?.error.message ?? 'The service could not complete that request.', body?.error.retryable, body?.error.retryAfterMs)
  }
  return response.json() as Promise<T>
}

export const api = {
  config: () => jsonRequest<PublicConfig>('/api/config'),
  session: (challengeToken?: string) => jsonRequest<{ expiresAt: number }>('/api/session', { method: 'POST', body: JSON.stringify(challengeToken ? { challengeToken } : {}) }),
  register: (request: RegisterRoomRequest) => jsonRequest<RegisterRoomResponse>('/api/rooms/register', { method: 'POST', body: JSON.stringify(request) }),
  control: (roomId: string, action: ControlAction) => jsonRequest<{ controlRevision: number }>(`/api/rooms/${encodeURIComponent(roomId)}/control`, { method: 'PATCH', body: JSON.stringify(action) }),
  skip: (roomId: string, body: { idempotencyKey: string; controlRevision: number; serverTurnId?: string }) => jsonRequest<{ controlRevision: number; runTurnsCompleted?: number; totalTurnsCompleted?: number }>(`/api/rooms/${encodeURIComponent(roomId)}/skip`, { method: 'POST', body: JSON.stringify(body) }),
}

function assertStreamEvent(value: unknown): StreamEvent {
  if (!value || typeof value !== 'object') throw new AgentRoomApiError('PROTOCOL_MISMATCH', 'The response stream was malformed.')
  const event = value as Record<string, unknown>
  if (!['queued', 'start', 'content', 'done', 'error'].includes(String(event.type)) || typeof event.requestId !== 'string') {
    throw new AgentRoomApiError('PROTOCOL_MISMATCH', 'The response stream used an unknown event.')
  }
  if (event.type === 'queued' && (typeof event.serverTurnId !== 'string' || !['short', 'busy'].includes(String(event.queueState)))) throw new AgentRoomApiError('PROTOCOL_MISMATCH', 'The queue event was malformed.')
  if (event.type === 'start' && (typeof event.serverTurnId !== 'string' || event.protocolTag !== PROTOCOL_TAG || typeof event.serverChosenAgentId !== 'string' || typeof event.actualModel !== 'string')) throw new AgentRoomApiError('PROTOCOL_MISMATCH', 'Reload to use the current AgentRoom protocol.')
  if (event.type === 'content' && (typeof event.serverTurnId !== 'string' || typeof event.delta !== 'string')) throw new AgentRoomApiError('PROTOCOL_MISMATCH', 'The response stream contained invalid content.')
  if (event.type === 'done' && (typeof event.serverTurnId !== 'string' || typeof event.actualModel !== 'string' || typeof event.durationMs !== 'number' || typeof event.controlRevision !== 'number' || typeof event.runTurnsCompleted !== 'number' || typeof event.totalTurnsCompleted !== 'number')) throw new AgentRoomApiError('PROTOCOL_MISMATCH', 'The completion event was malformed.')
  if (event.type === 'error' && (typeof event.code !== 'string' || typeof event.retryable !== 'boolean')) throw new AgentRoomApiError('PROTOCOL_MISMATCH', 'The error event was malformed.')
  return value as StreamEvent
}

function parseEventBlock(block: string): StreamEvent | undefined {
  const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
  const raw = data || block.trim()
  if (!raw || raw === '[DONE]') return undefined
  try { return assertStreamEvent(JSON.parse(raw)) } catch (error) {
    if (error instanceof AgentRoomApiError) throw error
    throw new AgentRoomApiError('PROTOCOL_MISMATCH', 'The response stream was not valid JSON.')
  }
}

export async function streamTurn(roomId: string, request: TurnRequest, signal: AbortSignal, onEvent: (event: StreamEvent) => void | Promise<void>): Promise<void> {
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/turn`, {
    method: 'POST', credentials: 'same-origin', signal,
    headers: { 'content-type': 'application/json', accept: 'text/event-stream, application/x-ndjson' }, body: JSON.stringify(request),
  })
  if (!response.ok) {
    let body: ApiError | undefined
    try { body = await response.json() as ApiError } catch { /* stable fallback */ }
    throw new AgentRoomApiError(body?.error.code ?? 'SERVICE_ERROR', body?.error.message ?? 'The turn could not start.', body?.error.retryable, body?.error.retryAfterMs)
  }
  if (!response.body) throw new AgentRoomApiError('SERVICE_ERROR', 'The service returned no response stream.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const isSse = response.headers.get('content-type')?.includes('text/event-stream') ?? false
  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n')
    const separator = isSse ? '\n\n' : '\n'
    let boundary = buffer.indexOf(separator)
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + separator.length)
      const event = parseEventBlock(block)
      if (event) await onEvent(event)
      boundary = buffer.indexOf(separator)
    }
    if (done) break
  }
  const finalEvent = parseEventBlock(buffer)
  if (finalEvent) await onEvent(finalEvent)
}
