import type { AgentProfile, MessageStatus, RoomStatus, RunStatus, TurnLimit } from '../shared/protocol'

export interface LocalRoom {
  id: string
  title: string
  topic: string
  status: RoomStatus
  totalTurnsCompleted: number
  activeRunId?: string
  controlRevision?: number
  createdAt: number
  updatedAt: number
  schemaRevision: 1
}

export interface LocalRun {
  id: string
  roomId: string
  turnLimit: TurnLimit
  turnsCompleted: number
  status: RunStatus
  createdAt: number
  finishedAt?: number
}

export interface LocalAgent extends AgentProfile {
  roomId: string
}

export interface LocalMessage {
  id: string
  roomId: string
  runId?: string
  senderType: 'user' | 'agent'
  senderId?: string
  senderName: string
  senderRole?: string
  content: string
  turnOrdinal?: number
  status: MessageStatus
  requestId?: string
  serverTurnId?: string
  mentions?: string[]
  errorCode?: string
  retryable?: boolean
  createdAt: number
  updatedAt: number
}

export interface RoomBundle {
  room: LocalRoom
  runs: LocalRun[]
  agents: LocalAgent[]
  messages: LocalMessage[]
}

export type ThemePreference = 'system' | 'light' | 'dark'
export type Language = 'en' | 'zh'
