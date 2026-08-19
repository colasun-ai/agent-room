import { isTurnLimit, normalizeAgentName, PROTOCOL_TAG, type AgentProfile, type ControlAction, type RegisterRoomRequest, type TranscriptMessage } from '../shared/protocol'
import type { ValidatedTurnPayload } from './types'

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const NAME = /^[\p{L}\p{N}_ -]{1,40}$/u

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object')
  return value as Record<string, unknown>
}

function text(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.trim().length === 0)) throw new Error('text')
  return value
}

function id(value: unknown): string {
  const result = text(value, 64)
  if (!ID.test(result) && !UUID.test(result)) throw new Error('id')
  return result
}

export async function readJson(request: Request, maxBytes = 128_000): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > maxBytes) throw new Error('size')
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new Error('size')
  return JSON.parse(raw) as unknown
}

export function validateRegister(value: unknown): RegisterRoomRequest {
  const data = object(value)
  const rosterRaw = data.roster
  if (!Array.isArray(rosterRaw) || rosterRaw.length < 2 || rosterRaw.length > 6) throw new Error('roster')
  const roster = rosterRaw.map((raw) => {
    const entry = object(raw), nameKey = normalizeAgentName(text(entry.nameKey, 40))
    if (!NAME.test(nameKey)) throw new Error('name')
    return { agentId: id(entry.agentId), nameKey, enabled: typeof entry.enabled === 'boolean' ? entry.enabled : (() => { throw new Error('enabled') })() }
  })
  if (new Set(roster.map((entry) => entry.agentId)).size !== roster.length || new Set(roster.map((entry) => entry.nameKey)).size !== roster.length || roster.filter((entry) => entry.enabled).length < 2) throw new Error('unique')
  if (!isTurnLimit(data.turnLimit) || data.protocolTag !== PROTOCOL_TAG) throw new Error('protocol')
  const runTurnsCompleted = Number(data.runTurnsCompleted), totalTurnsCompleted = Number(data.totalTurnsCompleted)
  if (!Number.isInteger(runTurnsCompleted) || runTurnsCompleted < 0 || runTurnsCompleted > data.turnLimit || !Number.isInteger(totalTurnsCompleted) || totalTurnsCompleted < runTurnsCompleted) throw new Error('turns')
  if (!['running', 'paused', 'finished'].includes(String(data.status)) || (data.status === 'finished') !== (runTurnsCompleted === data.turnLimit)) throw new Error('status')
  return { roomId: id(data.roomId), runId: id(data.runId), turnLimit: data.turnLimit, runTurnsCompleted, totalTurnsCompleted, status: data.status as 'running' | 'paused' | 'finished', protocolTag: PROTOCOL_TAG, roster }
}

function validateAgent(value: unknown): AgentProfile {
  const data = object(value)
  const name = text(data.name, 40)
  if (!NAME.test(name)) throw new Error('name')
  const temperature = data.temperature === undefined ? undefined : Number(data.temperature)
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 1.5)) throw new Error('temperature')
  if (typeof data.enabled !== 'boolean') throw new Error('enabled')
  return {
    id: id(data.id), name, normalizedName: normalizeAgentName(name), role: text(data.role, 120), avatar: text(data.avatar, 32), personality: text(data.personality, 1000), goal: text(data.goal, 1000),
    customInstructions: data.customInstructions === undefined ? undefined : text(data.customInstructions, 2000, true), temperature, enabled: data.enabled,
  }
}

function validateMessage(value: unknown): TranscriptMessage {
  const data = object(value)
  if (data.senderType !== 'user' && data.senderType !== 'agent') throw new Error('sender')
  if (data.status !== 'completed' && data.status !== 'retainedPartial') throw new Error('status')
  const senderId = data.senderId === undefined || data.senderId === null ? undefined : id(data.senderId)
  if (data.senderType === 'agent' && !senderId) throw new Error('senderId')
  const createdAt = Number(data.createdAt)
  if (!Number.isFinite(createdAt) || createdAt < 0) throw new Error('createdAt')
  return { id: id(data.id), senderType: data.senderType, senderId, senderName: text(data.senderName, 40), senderRole: data.senderRole === undefined ? undefined : text(data.senderRole, 120, true), content: text(data.content, 4000, true), status: data.status, createdAt }
}

export function validateTurn(value: unknown, pathRoomId: string): ValidatedTurnPayload {
  const data = object(value)
  const agentsRaw = data.agents, messagesRaw = data.messages
  if (!Array.isArray(agentsRaw) || agentsRaw.length < 2 || agentsRaw.length > 6 || !Array.isArray(messagesRaw) || messagesRaw.length > 60) throw new Error('arrays')
  const agents = agentsRaw.map(validateAgent)
  if (new Set(agents.map((agent) => agent.id)).size !== agents.length || new Set(agents.map((agent) => agent.normalizedName)).size !== agents.length) throw new Error('agents')
  const messages = messagesRaw.map(validateMessage)
  const profiles = new Map(agents.map((agent) => [agent.id, agent]))
  if (messages.some((message) => message.senderType === 'agent' && (!message.senderId || !profiles.has(message.senderId)))) throw new Error('senderProfile')
  for (const message of messages) {
    if (message.senderType === 'agent') {
      const profile = profiles.get(message.senderId!)!
      message.senderName = profile.name
      message.senderRole = profile.role
    } else {
      message.senderName = 'User'
      message.senderRole = undefined
    }
  }
  if (messages.reduce((sum, message) => sum + message.content.length, 0) > 50_000) throw new Error('content')
  const roomId = id(data.roomId)
  if (roomId !== pathRoomId || data.protocolTag !== PROTOCOL_TAG) throw new Error('protocol')
  const requestId = text(data.requestId, 64), idempotencyKey = text(data.idempotencyKey, 64)
  if (!UUID.test(requestId) || (!UUID.test(idempotencyKey) && !ID.test(idempotencyKey))) throw new Error('request')
  return {
    requestId, idempotencyKey, roomId, runId: id(data.runId), appBuildId: text(data.appBuildId, 80), topic: text(data.topic, 4000, true), agents, messages,
    latestUserDirectAddress: data.latestUserDirectAddress === undefined ? undefined : text(data.latestUserDirectAddress, 200, true),
    retryOfServerTurnId: data.retryOfServerTurnId === undefined ? undefined : id(data.retryOfServerTurnId),
    challengeToken: data.challengeToken === undefined ? undefined : text(data.challengeToken, 4096),
  }
}

export function validateControl(value: unknown): ControlAction {
  const data = object(value), common = { idempotencyKey: id(data.idempotencyKey), controlRevision: Number(data.controlRevision) }
  if (!Number.isInteger(common.controlRevision) || common.controlRevision < 1) throw new Error('revision')
  if (data.action === 'pause' || data.action === 'resume') return { action: data.action, ...common }
  if (data.action === 'continue') {
    if (!isTurnLimit(data.turnLimit)) throw new Error('limit')
    return { action: 'continue', ...common, runId: id(data.runId), turnLimit: data.turnLimit }
  }
  if (data.action === 'update-roster') {
    const validated = validateRegister({ roomId: 'placeholder', runId: 'placeholder', turnLimit: 6, runTurnsCompleted: 0, totalTurnsCompleted: 0, status: 'running', protocolTag: PROTOCOL_TAG, roster: data.roster })
    return { action: 'update-roster', ...common, roster: validated.roster }
  }
  throw new Error('action')
}

export function validateSkip(value: unknown): { idempotencyKey: string; controlRevision: number; serverTurnId?: string; latestUserDirectAddress?: string } {
  const data = object(value)
  const controlRevision = Number(data.controlRevision)
  if (!Number.isInteger(controlRevision) || controlRevision < 1) throw new Error('revision')
  return {
    idempotencyKey: id(data.idempotencyKey), controlRevision,
    serverTurnId: data.serverTurnId === undefined ? undefined : id(data.serverTurnId),
    latestUserDirectAddress: data.latestUserDirectAddress === undefined ? undefined : text(data.latestUserDirectAddress, 200, true),
  }
}
