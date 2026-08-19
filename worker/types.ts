import type { AgentProfile, ErrorCode, RegisterRoomRequest, TranscriptMessage } from '../shared/protocol'

export interface Env {
  CONTROL_PLANE: DurableObjectNamespace
  ENVIRONMENT: string
  AI_ENABLED: string
  DEFAULT_MODEL_ENABLED?: string
  NVIDIA_API_KEY?: string
  NVIDIA_BASE_URL: string
  DEFAULT_MODEL: string
  PUBLIC_ORIGIN: string
  PROTOCOL_TAG: string
  OPERATING_UPSTREAM_RPM: string
  GLOBAL_DAILY_ATTEMPT_LIMIT: string
  MAX_CONCURRENT_UPSTREAM: string
  EFFECTIVE_DAILY_ATTEMPT_LIMIT?: string
  SESSION_HMAC_SECRET: string
  RISK_HMAC_SECRET?: string
  TURNSTILE_SECRET_KEY?: string
  TURNSTILE_SITE_KEY?: string
  TURNSTILE_EXPECTED_HOSTNAME?: string
  SMOKE_TEST_SECRET?: string
  MOCK_UPSTREAM?: string
  MAX_OUTPUT_TOKENS?: string
}

export interface SessionIdentity {
  sessionId: string
  expiresAt: number
}

export interface RosterEntry {
  agentId: string
  nameKey: string
  enabled: boolean
}

export interface FairnessState {
  turnsSinceSpoke: Record<string, number>
  consecutiveBoosts: number
}

export interface RoomRecord {
  roomId: string
  sessionId: string
  roster: RosterEntry[]
  cursorIndex: number
  activeRunId: string
  runTurnLimit: number
  runTurnsCompleted: number
  totalTurnsCompleted: number
  status: 'running' | 'paused' | 'finished'
  activeLease?: { leaseId: string; serverTurnId: string; expiresAt: number }
  lastCompletedSpeakerId?: string
  lastAcceptedMentions: string[]
  fairness: FairnessState
  controlRevision: number
  failedTurns: Record<string, string>
  expiresAt: number
  updatedAt: number
}

export interface TurnBeginRequest {
  sessionId: string
  requestId: string
  idempotencyKey: string
  roomId: string
  runId: string
  latestUserDirectAddress?: string
  retryOfServerTurnId?: string
  now: number
}

export interface TurnBeginResult {
  serverTurnId: string
  leaseId: string
  speakerId: string
  speakerNameKey: string
  boosted: boolean
  duplicate?: boolean
  expiresAt: number
}

export interface ValidatedTurnPayload {
  requestId: string
  idempotencyKey: string
  roomId: string
  runId: string
  appBuildId: string
  topic: string
  agents: AgentProfile[]
  messages: TranscriptMessage[]
  latestUserDirectAddress?: string
  retryOfServerTurnId?: string
  challengeToken?: string
}

export type ValidatedRegisterPayload = RegisterRoomRequest

export class ApiProblem extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    public readonly retryable = false,
    public readonly retryAfterMs?: number,
  ) {
    super(code)
  }
}
