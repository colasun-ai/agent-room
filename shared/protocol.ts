export const PROTOCOL_TAG = 'agentroom.v1' as const
export const CONTROL_SCHEMA_REVISION = 1 as const
export const DB_SCHEMA_REVISION = 1 as const
export const TURN_LIMITS = [6, 12, 20] as const

export type TurnLimit = (typeof TURN_LIMITS)[number]
export type RoomStatus = 'draft' | 'running' | 'paused' | 'finished' | 'error'
export type RunStatus = 'running' | 'paused' | 'finished'
export type MessageStatus =
  | 'pending'
  | 'waiting'
  | 'thinking'
  | 'streaming'
  | 'completed'
  | 'stopped'
  | 'interrupted'
  | 'retainedPartial'
  | 'error'

export interface AgentProfile {
  id: string
  name: string
  normalizedName: string
  role: string
  avatar: string
  personality: string
  goal: string
  customInstructions?: string
  temperature?: number
  enabled: boolean
}

export interface TranscriptMessage {
  id: string
  senderType: 'user' | 'agent'
  senderId?: string
  senderName: string
  senderRole?: string
  content: string
  status: 'completed' | 'retainedPartial'
  createdAt: number
}

export interface PublicConfig {
  releaseClass: 'PUBLIC_BETA'
  protocolTag: typeof PROTOCOL_TAG
  controlSchemaRevision: typeof CONTROL_SCHEMA_REVISION
  aiEnabled: boolean
  capacityState: 'available' | 'busy' | 'daily-exhausted' | 'disabled'
  limits: { agentsMin: 2; agentsMax: 6; turnLimits: readonly TurnLimit[] }
  turnstileSiteKey?: string
}

export interface RegisterRoomRequest {
  roomId: string
  runId: string
  turnLimit: TurnLimit
  protocolTag: typeof PROTOCOL_TAG
  roster: Array<{ agentId: string; nameKey: string; enabled: boolean }>
}

export interface RegisterRoomResponse {
  roomId: string
  runId: string
  controlRevision: number
  expiresAt: number
}

export type ControlAction =
  | { action: 'pause'; idempotencyKey: string; controlRevision: number }
  | { action: 'resume'; idempotencyKey: string; controlRevision: number }
  | { action: 'continue'; idempotencyKey: string; controlRevision: number; runId: string; turnLimit: TurnLimit }
  | { action: 'update-roster'; idempotencyKey: string; controlRevision: number; roster: RegisterRoomRequest['roster'] }

export interface TurnRequest {
  requestId: string
  idempotencyKey: string
  roomId: string
  runId: string
  protocolTag: typeof PROTOCOL_TAG
  appBuildId: string
  topic: string
  agents: AgentProfile[]
  messages: TranscriptMessage[]
  latestUserDirectAddress?: string
  retryOfServerTurnId?: string
  challengeToken?: string
}

export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'SESSION_REQUIRED'
  | 'SESSION_EXPIRED'
  | 'CHALLENGE_REQUIRED'
  | 'ROOM_NOT_REGISTERED'
  | 'ROOM_BUSY'
  | 'RUN_COMPLETE'
  | 'RATE_LIMITED'
  | 'CAPACITY_EXHAUSTED'
  | 'DAILY_CAPACITY_EXHAUSTED'
  | 'QUEUE_TIMEOUT'
  | 'UPSTREAM_RATE_LIMITED'
  | 'UPSTREAM_AUTH_ERROR'
  | 'MODEL_UNAVAILABLE'
  | 'REQUEST_ABORTED'
  | 'PROTOCOL_MISMATCH'
  | 'SERVICE_DISABLED'
  | 'SERVICE_UNAVAILABLE'
  | 'SERVICE_ERROR'

export type StreamEvent =
  | { type: 'queued'; requestId: string; serverTurnId: string; queueState: 'short' | 'busy' }
  | { type: 'start'; requestId: string; serverTurnId: string; serverChosenAgentId: string; actualModel: string; protocolTag: typeof PROTOCOL_TAG }
  | { type: 'content'; requestId: string; serverTurnId: string; delta: string }
  | { type: 'done'; requestId: string; serverTurnId: string; actualModel: string; durationMs: number; usage?: { inputTokens?: number; outputTokens?: number } }
  | { type: 'error'; requestId: string; serverTurnId?: string; code: ErrorCode; retryable: boolean; retryAfterMs?: number }

export interface ApiError {
  error: { code: ErrorCode; message: string; requestId?: string; retryable: boolean; retryAfterMs?: number }
}

export function normalizeAgentName(name: string): string {
  return name.trim().normalize('NFKC').toLocaleLowerCase('en-US')
}

export function isTurnLimit(value: unknown): value is TurnLimit {
  return TURN_LIMITS.includes(value as TurnLimit)
}

