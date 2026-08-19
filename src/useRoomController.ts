import { useCallback, useEffect, useRef, useState } from 'react'
import { PROTOCOL_TAG, type RegisterRoomRequest, type TranscriptMessage, type TurnLimit, type TurnRequest } from '../shared/protocol'
import { AgentRoomApiError, api, streamTurn } from './api'
import { RoomCoordinator } from './coordination'
import { createStreamingWriter, loadRoom, putAgents, putMessage, putRoom, putRun } from './db'
import { latestUserDirectAddress, parseMentions } from './mentions'
import type { LocalAgent, LocalMessage, LocalRoom, LocalRun, RoomBundle } from './model'

function activeRun(bundle: RoomBundle): LocalRun | undefined { return bundle.runs.find((run) => run.id === bundle.room.activeRunId) }

function registration(bundle: RoomBundle): RegisterRoomRequest {
  const run = activeRun(bundle)
  if (!run) throw new Error('No active run')
  return {
    roomId: bundle.room.id, runId: run.id, turnLimit: run.turnLimit, protocolTag: PROTOCOL_TAG,
    roster: bundle.agents.map((agent) => ({ agentId: agent.id, nameKey: agent.normalizedName, enabled: agent.enabled })),
  }
}

function transcript(messages: LocalMessage[]): TranscriptMessage[] {
  return messages.filter((message) => message.status === 'completed' || message.status === 'retainedPartial').map((message) => ({
    id: message.id, senderType: message.senderType, senderId: message.senderId, senderName: message.senderName, senderRole: message.senderRole,
    content: message.content, status: message.status as 'completed' | 'retainedPartial', createdAt: message.createdAt,
  }))
}

export function useRoomController(roomId: string) {
  const [bundle, setBundle] = useState<RoomBundle>()
  const [loading, setLoading] = useState(true)
  const [driver, setDriver] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState(false)
  const activeRequest = useRef<{ controller: AbortController; messageId: string } | undefined>(undefined)
  const phase = useRef<'idle' | 'waiting' | 'streaming'>('idle')
  const coordinator = useRef<RoomCoordinator | undefined>(undefined)
  const bundleRef = useRef<RoomBundle | undefined>(undefined)

  useEffect(() => { bundleRef.current = bundle }, [bundle])

  const refresh = useCallback(async () => {
    const next = await loadRoom(roomId)
    setBundle(next)
    setLoading(false)
  }, [roomId])

  useEffect(() => {
    let disposed = false
    void Promise.resolve().then(refresh)
    const roomCoordinator = new RoomCoordinator(roomId, () => void refresh())
    coordinator.current = roomCoordinator
    void roomCoordinator.acquire().then((acquired) => { if (!disposed) setDriver(acquired) })
    return () => { disposed = true; activeRequest.current?.controller.abort(); roomCoordinator.close() }
  }, [refresh, roomId])

  const commitBundle = useCallback((updater: (current: RoomBundle) => RoomBundle) => {
    setBundle((current) => {
      if (!current) return current
      const next = updater(current); bundleRef.current = next; return next
    })
    coordinator.current?.changed()
  }, [])

  const register = useCallback(async (current: RoomBundle) => {
    await api.session()
    const response = await api.register(registration(current))
    const room = { ...current.room, controlRevision: response.controlRevision, updatedAt: Date.now() }
    await putRoom(room)
    commitBundle((value) => ({ ...value, room }))
    return response.controlRevision
  }, [commitBundle])

  const startTurn = useCallback(async (retryOfServerTurnId?: string) => {
    const current = bundleRef.current
    if (!current || activeRequest.current || current.room.status !== 'running' || !coordinator.current?.isDriver()) return
    const run = activeRun(current)
    if (!run || run.turnsCompleted >= run.turnLimit) return
    const controller = new AbortController()
    const requestId = crypto.randomUUID()
    const messageId = crypto.randomUUID()
    const now = Date.now()
    let message: LocalMessage = {
      id: messageId, roomId, runId: run.id, senderType: 'agent', senderName: 'Agent', content: '', status: 'pending', requestId,
      turnOrdinal: current.room.totalTurnsCompleted + 1, createdAt: now, updatedAt: now,
    }
    await putMessage(message)
    commitBundle((value) => ({ ...value, messages: [...value.messages, message] }))
    const writer = createStreamingWriter(message)
    activeRequest.current = { controller, messageId }
    phase.current = 'waiting'
    setNotice(undefined)
    let started = false
    let completed = false
    let chosenAgent: LocalAgent | undefined
    let serverTurnId: string | undefined
    try {
      let controlRevision = current.room.controlRevision
      if (controlRevision === undefined) controlRevision = await register(current)
      const latestUser = [...current.messages].reverse().find((item) => item.senderType === 'user' && item.status === 'completed')
      const request: TurnRequest = {
        requestId, idempotencyKey: crypto.randomUUID(), roomId, runId: run.id, protocolTag: PROTOCOL_TAG,
        appBuildId: import.meta.env.VITE_APP_BUILD_ID ?? 'dev', topic: current.room.topic,
        agents: current.agents.map((agent) => ({ id: agent.id, name: agent.name, normalizedName: agent.normalizedName, role: agent.role, avatar: agent.avatar, personality: agent.personality, goal: agent.goal, customInstructions: agent.customInstructions, temperature: agent.temperature, enabled: agent.enabled })), messages: transcript(current.messages),
        latestUserDirectAddress: latestUser ? latestUserDirectAddress(latestUser.content, current.agents) : undefined,
        retryOfServerTurnId,
      }
      await streamTurn(roomId, request, controller.signal, async (event) => {
        if (event.requestId !== requestId) throw new AgentRoomApiError('PROTOCOL_MISMATCH', 'The stream request identifier changed.')
        if (completed) throw new AgentRoomApiError('PROTOCOL_MISMATCH', 'The stream continued after its terminal event.')
        if (event.type === 'queued') {
          if (started) throw new AgentRoomApiError('PROTOCOL_MISMATCH', 'A queued event arrived after generation started.')
          serverTurnId = event.serverTurnId; setBusy(event.queueState === 'busy')
          message = { ...message, status: 'waiting', serverTurnId, updatedAt: Date.now() }
          await writer.finish(message); commitBundle((value) => ({ ...value, messages: value.messages.map((item) => item.id === messageId ? message : item) }))
        } else if (event.type === 'start') {
          if (started || (serverTurnId && event.serverTurnId !== serverTurnId)) throw new AgentRoomApiError('PROTOCOL_MISMATCH', 'The stream started with inconsistent turn data.')
          chosenAgent = current.agents.find((agent) => agent.id === event.serverChosenAgentId && agent.enabled)
          if (!chosenAgent) throw new AgentRoomApiError('PROTOCOL_MISMATCH', 'The server selected an unavailable agent.')
          started = true; serverTurnId = event.serverTurnId; phase.current = 'streaming'; setBusy(false)
          message = { ...message, senderId: chosenAgent.id, senderName: chosenAgent.name, senderRole: chosenAgent.role, serverTurnId, status: 'thinking', updatedAt: Date.now() }
          await writer.finish(message); commitBundle((value) => ({ ...value, messages: value.messages.map((item) => item.id === messageId ? message : item) }))
        } else if (event.type === 'content') {
          if (!started || event.serverTurnId !== serverTurnId) throw new AgentRoomApiError('PROTOCOL_MISMATCH', 'Content arrived before a trusted speaker was selected.')
          message = { ...message, content: message.content + event.delta, status: 'streaming', updatedAt: Date.now() }
          writer.update(message); commitBundle((value) => ({ ...value, messages: value.messages.map((item) => item.id === messageId ? message : item) }))
        } else if (event.type === 'done') {
          if (!started || event.serverTurnId !== serverTurnId) throw new AgentRoomApiError('PROTOCOL_MISMATCH', 'The turn completed without a trusted speaker.')
          completed = true
          message = { ...message, status: 'completed', mentions: parseMentions(message.content, current.agents), updatedAt: Date.now() }
          await writer.finish(message)
          const nextTurns = run.turnsCompleted + 1
          const nextRun: LocalRun = { ...run, turnsCompleted: nextTurns, status: nextTurns >= run.turnLimit ? 'finished' : 'running', ...(nextTurns >= run.turnLimit ? { finishedAt: Date.now() } : {}) }
          const nextRoom: LocalRoom = { ...current.room, status: nextTurns >= run.turnLimit ? 'finished' : (bundleRef.current?.room.status === 'paused' ? 'paused' : 'running'), totalTurnsCompleted: current.room.totalTurnsCompleted + 1, updatedAt: Date.now() }
          await Promise.all([putRun(nextRun), putRoom(nextRoom)])
          commitBundle((value) => ({ ...value, room: nextRoom, runs: value.runs.map((item) => item.id === run.id ? nextRun : item), messages: value.messages.map((item) => item.id === messageId ? message : item) }))
        } else if (event.type === 'error') {
          throw new AgentRoomApiError(event.code, event.code, event.retryable, event.retryAfterMs)
        }
      })
      if (!completed) throw new AgentRoomApiError('SERVICE_ERROR', 'The response stream ended unexpectedly.', true)
    } catch (error) {
      const aborted = controller.signal.aborted
      const apiError = error instanceof AgentRoomApiError ? error : undefined
      message = {
        ...message, status: aborted ? (message.content ? 'interrupted' : 'stopped') : (message.content ? 'interrupted' : 'error'),
        errorCode: aborted ? 'REQUEST_ABORTED' : (apiError?.code ?? 'SERVICE_ERROR'), retryable: apiError?.retryable ?? !aborted, updatedAt: Date.now(),
      }
      await writer.finish(message)
      const latest = bundleRef.current
      const failedRoom = latest ? { ...latest.room, status: 'paused' as const, updatedAt: Date.now() } : undefined
      const failedRun = latest && failedRoom ? activeRun(latest) : undefined
      const pausedRun = failedRun ? { ...failedRun, status: 'paused' as const } : undefined
      await Promise.all([...(failedRoom ? [putRoom(failedRoom)] : []), ...(pausedRun ? [putRun(pausedRun)] : [])])
      commitBundle((value) => ({
        ...value,
        room: failedRoom ?? value.room,
        runs: pausedRun ? value.runs.map((item) => item.id === pausedRun.id ? pausedRun : item) : value.runs,
        messages: value.messages.map((item) => item.id === messageId ? message : item),
      }))
      if (!aborted) setNotice(apiError?.code ?? 'SERVICE_ERROR')
    } finally {
      activeRequest.current = undefined; phase.current = 'idle'; setBusy(false)
    }
  }, [commitBundle, register, roomId])

  useEffect(() => {
    if (!bundle || !driver || bundle.room.status !== 'running' || activeRequest.current) return
    const run = activeRun(bundle)
    if (!run || run.turnsCompleted >= run.turnLimit) return
    const timer = window.setTimeout(() => void startTurn(), bundle.messages.length ? 650 : 0)
    return () => window.clearTimeout(timer)
  }, [bundle, driver, startTurn])

  const setRoomStatus = useCallback(async (status: 'paused' | 'running') => {
    const current = bundleRef.current
    if (!current) return
    const revision = current.room.controlRevision ?? await register(current)
    const response = await api.control(roomId, { action: status === 'paused' ? 'pause' : 'resume', controlRevision: revision, idempotencyKey: crypto.randomUUID() })
    const room = { ...current.room, status, controlRevision: response.controlRevision, updatedAt: Date.now() }
    const run = activeRun(current)
    const nextRun = run ? { ...run, status } : undefined
    await Promise.all([putRoom(room), ...(nextRun ? [putRun(nextRun)] : [])])
    if (status === 'paused' && phase.current === 'waiting') activeRequest.current?.controller.abort()
    commitBundle((value) => ({ ...value, room, runs: nextRun ? value.runs.map((item) => item.id === nextRun.id ? nextRun : item) : value.runs }))
  }, [commitBundle, register, roomId])

  const stop = useCallback(async () => {
    activeRequest.current?.controller.abort()
    try { await setRoomStatus('paused') } catch { /* abort remains real even if control response is lost */ }
  }, [setRoomStatus])

  const sendUserMessage = useCallback(async (content: string) => {
    const current = bundleRef.current
    if (!current || !content.trim()) return
    const now = Date.now()
    const message: LocalMessage = { id: crypto.randomUUID(), roomId, runId: current.room.activeRunId, senderType: 'user', senderName: 'You', content: content.trim().slice(0, 4000), status: 'completed', mentions: parseMentions(content, current.agents), createdAt: now, updatedAt: now }
    await putMessage(message)
    const room = { ...current.room, updatedAt: now }
    await putRoom(room)
    commitBundle((value) => ({ ...value, room, messages: [...value.messages, message] }))
  }, [commitBundle, roomId])

  const continueRun = useCallback(async (turnLimit: TurnLimit) => {
    const current = bundleRef.current
    if (!current) return
    const revision = current.room.controlRevision ?? await register(current)
    const run: LocalRun = { id: crypto.randomUUID(), roomId, turnLimit, turnsCompleted: 0, status: 'running', createdAt: Date.now() }
    const response = await api.control(roomId, { action: 'continue', idempotencyKey: crypto.randomUUID(), controlRevision: revision, runId: run.id, turnLimit })
    const room: LocalRoom = { ...current.room, status: 'running', activeRunId: run.id, controlRevision: response.controlRevision, updatedAt: Date.now() }
    await Promise.all([putRun(run), putRoom(room)])
    commitBundle((value) => ({ ...value, room, runs: [...value.runs, run] }))
  }, [commitBundle, register, roomId])

  const retry = useCallback(async (message: LocalMessage) => {
    const current = bundleRef.current
    if (!current || activeRequest.current) return
    if (current.room.status !== 'running') {
      await setRoomStatus('running')
    }
    await startTurn(message.serverTurnId)
  }, [setRoomStatus, startTurn])

  const skip = useCallback(async (message: LocalMessage) => {
    const current = bundleRef.current
    const run = current && activeRun(current)
    if (!current || !run) return
    const revision = current.room.controlRevision ?? await register(current)
    const response = await api.skip(roomId, { idempotencyKey: crypto.randomUUID(), controlRevision: revision, serverTurnId: message.serverTurnId })
    const turnsCompleted = response.runTurnsCompleted ?? run.turnsCompleted + 1
    const nextRun: LocalRun = { ...run, turnsCompleted, status: turnsCompleted >= run.turnLimit ? 'finished' : 'running', ...(turnsCompleted >= run.turnLimit ? { finishedAt: Date.now() } : {}) }
    const room: LocalRoom = { ...current.room, status: turnsCompleted >= run.turnLimit ? 'finished' : 'running', controlRevision: response.controlRevision, totalTurnsCompleted: response.totalTurnsCompleted ?? current.room.totalTurnsCompleted + 1, updatedAt: Date.now() }
    await Promise.all([putRun(nextRun), putRoom(room)])
    commitBundle((value) => ({ ...value, room, runs: value.runs.map((item) => item.id === run.id ? nextRun : item) }))
  }, [commitBundle, register, roomId])

  const keepPartial = useCallback(async (message: LocalMessage) => {
    const next: LocalMessage = { ...message, status: 'retainedPartial', updatedAt: Date.now() }
    await putMessage(next)
    commitBundle((value) => ({ ...value, messages: value.messages.map((item) => item.id === message.id ? next : item) }))
  }, [commitBundle])

  const saveAgents = useCallback(async (agents: LocalAgent[]) => {
    const current = bundleRef.current
    if (!current) return
    const revision = current.room.controlRevision ?? await register(current)
    const response = await api.control(roomId, { action: 'update-roster', idempotencyKey: crypto.randomUUID(), controlRevision: revision, roster: agents.map((agent) => ({ agentId: agent.id, nameKey: agent.normalizedName, enabled: agent.enabled })) })
    const room = { ...current.room, controlRevision: response.controlRevision, updatedAt: Date.now() }
    await Promise.all([putAgents(agents), putRoom(room)])
    commitBundle((value) => ({ ...value, room, agents }))
  }, [commitBundle, register, roomId])

  return { bundle, loading, driver, notice, busy, refresh, pause: () => setRoomStatus('paused'), resume: () => setRoomStatus('running'), stop, sendUserMessage, continueRun, retry, skip, keepPartial, saveAgents }
}
