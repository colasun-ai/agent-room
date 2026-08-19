import { useCallback, useEffect, useRef, useState } from 'react'
import { PROTOCOL_TAG, type RegisterRoomRequest, type TranscriptMessage, type TurnLimit, type TurnRequest } from '../shared/protocol'
import { AgentRoomApiError, api, streamTurn } from './api'
import { RoomCoordinator } from './coordination'
import { createStreamingWriter, loadRoom, putAgents, putMessage, putRoom, putRun } from './db'
import { latestUserDirectAddress, parseMentions } from './mentions'
import type { LocalAgent, LocalMessage, LocalRoom, LocalRun, RoomBundle } from './model'

function activeRun(bundle: RoomBundle): LocalRun | undefined { return bundle.runs.find((run) => run.id === bundle.room.activeRunId) }

function controlExpired(error: unknown): error is AgentRoomApiError {
  return error instanceof AgentRoomApiError && ['SESSION_REQUIRED', 'SESSION_EXPIRED', 'ROOM_NOT_REGISTERED'].includes(error.code)
}

function registration(bundle: RoomBundle): RegisterRoomRequest {
  const run = activeRun(bundle)
  if (!run) throw new Error('No active run')
  return {
    roomId: bundle.room.id, runId: run.id, turnLimit: run.turnLimit, runTurnsCompleted: run.turnsCompleted, totalTurnsCompleted: bundle.room.totalTurnsCompleted, status: bundle.room.status === 'draft' ? 'paused' : bundle.room.status, protocolTag: PROTOCOL_TAG,
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
  const [challengeSiteKey, setChallengeSiteKey] = useState<string>()
  const [challengeVerifying, setChallengeVerifying] = useState(false)
  const [challengeRequired, setChallengeRequired] = useState(false)
  const activeRequest = useRef<{ controller: AbortController; messageId: string } | undefined>(undefined)
  const phase = useRef<'idle' | 'waiting' | 'streaming'>('idle')
  const challengeRetry = useRef<(() => Promise<unknown>) | undefined>(undefined)
  const startTurnRef = useRef<(retryOfServerTurnId?: string) => Promise<void>>(async () => undefined)
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
    let retryTimer: number | undefined
    void Promise.resolve().then(refresh)
    const roomCoordinator = new RoomCoordinator(roomId, () => void refresh())
    coordinator.current = roomCoordinator
    const acquireDriver = async () => {
      const acquired = await roomCoordinator.acquire()
      if (disposed) return
      setDriver(acquired)
      if (!acquired) retryTimer = window.setTimeout(() => void acquireDriver(), 500)
    }
    void acquireDriver()
    return () => { disposed = true; if (retryTimer) window.clearTimeout(retryTimer); activeRequest.current?.controller.abort(); roomCoordinator.close() }
  }, [refresh, roomId])

  const commitBundle = useCallback((updater: (current: RoomBundle) => RoomBundle) => {
    const current = bundleRef.current
    if (!current) return
    const next = updater(current)
    bundleRef.current = next
    setBundle(next)
    coordinator.current?.changed()
  }, [])

  const requestChallenge = useCallback(async () => {
    setChallengeRequired(true)
    const config = await api.config().catch(() => undefined)
    setChallengeSiteKey(config?.turnstileSiteKey)
    setNotice(config?.turnstileSiteKey ? undefined : 'CHALLENGE_UNAVAILABLE')
  }, [])

  const reportError = useCallback(async (error: unknown, retry?: () => Promise<unknown>) => {
    if (error instanceof AgentRoomApiError && error.code === 'CHALLENGE_REQUIRED') {
      challengeRetry.current = retry
      await requestChallenge()
      return
    }
    setNotice(error instanceof AgentRoomApiError ? error.code : 'SERVICE_ERROR')
  }, [requestChallenge])

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
          const nextTurns = event.runTurnsCompleted
          const nextRun: LocalRun = { ...run, turnsCompleted: nextTurns, status: nextTurns >= run.turnLimit ? 'finished' : 'running', ...(nextTurns >= run.turnLimit ? { finishedAt: Date.now() } : {}) }
          const nextRoom: LocalRoom = { ...current.room, status: nextTurns >= run.turnLimit ? 'finished' : (bundleRef.current?.room.status === 'paused' ? 'paused' : 'running'), controlRevision: event.controlRevision, totalTurnsCompleted: event.totalTurnsCompleted, updatedAt: Date.now() }
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
      const expired = controlExpired(apiError)
      const challenged = apiError?.code === 'CHALLENGE_REQUIRED'
      const failedRoom = latest ? { ...latest.room, status: challenged ? latest.room.status : 'paused' as const, ...(expired ? { controlRevision: undefined } : {}), updatedAt: Date.now() } : undefined
      const failedRun = latest && failedRoom ? activeRun(latest) : undefined
      const pausedRun = failedRun ? { ...failedRun, status: challenged ? failedRun.status : 'paused' as const } : undefined
      await Promise.all([...(failedRoom ? [putRoom(failedRoom)] : []), ...(pausedRun ? [putRun(pausedRun)] : [])])
      commitBundle((value) => ({
        ...value,
        room: failedRoom ?? value.room,
        runs: pausedRun ? value.runs.map((item) => item.id === pausedRun.id ? pausedRun : item) : value.runs,
        messages: value.messages.map((item) => item.id === messageId ? message : item),
      }))
      if (!aborted) await reportError(apiError ?? error, () => startTurnRef.current(retryOfServerTurnId))
    } finally {
      try { await writer.close(message) } finally {
        activeRequest.current = undefined; phase.current = 'idle'; setBusy(false)
      }
    }
  }, [commitBundle, register, reportError, roomId])

  useEffect(() => { startTurnRef.current = startTurn }, [startTurn])

  useEffect(() => {
    if (!bundle || !driver || challengeRequired || bundle.room.status !== 'running' || activeRequest.current) return
    const run = activeRun(bundle)
    if (!run || run.turnsCompleted >= run.turnLimit) return
    const timer = window.setTimeout(() => void startTurn(), bundle.messages.length ? 650 : 0)
    return () => window.clearTimeout(timer)
  }, [bundle, challengeRequired, driver, startTurn])

  const setRoomStatus = useCallback(async (status: 'paused' | 'running') => {
    const current = bundleRef.current
    if (!current) return false
    if (status === 'paused') {
      const room: LocalRoom = { ...current.room, status: 'paused', updatedAt: Date.now() }
      const run = activeRun(current)
      const nextRun = run ? { ...run, status: 'paused' as const } : undefined
      await Promise.all([putRoom(room), ...(nextRun ? [putRun(nextRun)] : [])])
      commitBundle((value) => ({ ...value, room, runs: nextRun ? value.runs.map((item) => item.id === nextRun.id ? nextRun : item) : value.runs }))
    }
    let recovered = current.room.controlRevision === undefined
    let revision = current.room.controlRevision ?? await register(bundleRef.current ?? current)
    if (status === 'paused' && phase.current === 'waiting') activeRequest.current?.controller.abort()
    let nextRevision = revision
    let confirmed = false
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await api.control(roomId, { action: status === 'paused' ? 'pause' : 'resume', controlRevision: revision, idempotencyKey: crypto.randomUUID() })
        nextRevision = response.controlRevision
        confirmed = true
        break
      } catch (error) {
        if (controlExpired(error) || (attempt === 0 && status === 'paused' && error instanceof AgentRoomApiError && error.code === 'INVALID_REQUEST')) {
          recovered = true
          revision = await register(bundleRef.current ?? current)
          continue
        }
        if (status === 'paused' && error instanceof AgentRoomApiError && error.code === 'ROOM_BUSY' && attempt < 3) {
          await new Promise((resolve) => window.setTimeout(resolve, 80 * (2 ** attempt)))
          revision = bundleRef.current?.room.controlRevision ?? revision
          continue
        }
        throw error
      }
    }
    if (!confirmed) throw new AgentRoomApiError('SERVICE_UNAVAILABLE', 'Room state could not be synchronized.', true)
    const latest = bundleRef.current ?? current
    const room = { ...latest.room, status, controlRevision: Math.max(nextRevision, latest.room.controlRevision ?? 0), updatedAt: Date.now() }
    const run = activeRun(latest)
    const nextRun = run ? { ...run, status } : undefined
    await Promise.all([putRoom(room), ...(nextRun ? [putRun(nextRun)] : [])])
    commitBundle((value) => ({ ...value, room, runs: nextRun ? value.runs.map((item) => item.id === nextRun.id ? nextRun : item) : value.runs }))
    return recovered
  }, [commitBundle, register, roomId])

  const stop = useCallback(async () => {
    activeRequest.current?.controller.abort()
    try { await setRoomStatus('paused') } catch (error) { await reportError(error, () => setRoomStatus('paused')) }
  }, [reportError, setRoomStatus])

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
    let revision = current.room.controlRevision ?? await register(current)
    const run: LocalRun = { id: crypto.randomUUID(), roomId, turnLimit, turnsCompleted: 0, status: 'running', createdAt: Date.now() }
    let response: { controlRevision: number }
    try {
      response = await api.control(roomId, { action: 'continue', idempotencyKey: crypto.randomUUID(), controlRevision: revision, runId: run.id, turnLimit })
    } catch (error) {
      if (!controlExpired(error)) throw error
      const recovered: RoomBundle = { ...current, room: { ...current.room, activeRunId: run.id, status: 'running' }, runs: [...current.runs, run] }
      revision = await register(recovered)
      response = { controlRevision: revision }
    }
    const room: LocalRoom = { ...current.room, status: 'running', activeRunId: run.id, controlRevision: response.controlRevision, updatedAt: Date.now() }
    await Promise.all([putRun(run), putRoom(room)])
    commitBundle((value) => ({ ...value, room, runs: [...value.runs, run] }))
  }, [commitBundle, register, roomId])

  const retry = useCallback(async (message: LocalMessage) => {
    const current = bundleRef.current
    if (!current || activeRequest.current) return
    let recovered = current.room.controlRevision === undefined
    if (current.room.status !== 'running') {
      recovered = (await setRoomStatus('running')) || recovered
    }
    await startTurn(recovered ? undefined : message.serverTurnId)
  }, [setRoomStatus, startTurn])

  const skip = useCallback(async (message: LocalMessage) => {
    const current = bundleRef.current
    const run = current && activeRun(current)
    if (!current || !run) return
    let recoveredControl = current.room.controlRevision === undefined
    const recoveryBundle: RoomBundle = { ...current, room: { ...current.room, status: 'running' } }
    let revision = current.room.controlRevision ?? await register(recoveryBundle)
    let response
    try {
      response = await api.skip(roomId, { idempotencyKey: crypto.randomUUID(), controlRevision: revision, ...(recoveredControl ? {} : { serverTurnId: message.serverTurnId }) })
    } catch (error) {
      if (!controlExpired(error)) throw error
      recoveredControl = true
      revision = await register(recoveryBundle)
      response = await api.skip(roomId, { idempotencyKey: crypto.randomUUID(), controlRevision: revision })
    }
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
    let revision = current.room.controlRevision ?? await register(current)
    let response
    try {
      response = await api.control(roomId, { action: 'update-roster', idempotencyKey: crypto.randomUUID(), controlRevision: revision, roster: agents.map((agent) => ({ agentId: agent.id, nameKey: agent.normalizedName, enabled: agent.enabled })) })
    } catch (error) {
      if (!controlExpired(error)) throw error
      revision = await register(current)
      response = await api.control(roomId, { action: 'update-roster', idempotencyKey: crypto.randomUUID(), controlRevision: revision, roster: agents.map((agent) => ({ agentId: agent.id, nameKey: agent.normalizedName, enabled: agent.enabled })) })
    }
    const room = { ...current.room, controlRevision: response.controlRevision, updatedAt: Date.now() }
    await Promise.all([putAgents(agents), putRoom(room)])
    commitBundle((value) => ({ ...value, room, agents }))
    return true
  }, [commitBundle, register, roomId])

  const verifyChallenge = useCallback(async (token: string) => {
    if (challengeVerifying) return
    setChallengeVerifying(true)
    const retry = challengeRetry.current
    try {
      await api.session(token)
      setChallengeSiteKey(undefined)
      setChallengeRequired(false)
      setNotice(undefined)
      if (retry) await retry()
      challengeRetry.current = undefined
    } catch (error) {
      await reportError(error, retry)
    } finally {
      setChallengeVerifying(false)
    }
  }, [challengeVerifying, reportError])

  const safeAction = useCallback(async (action: () => Promise<unknown>) => {
    try { return await action() } catch (error) { await reportError(error, action); return undefined }
  }, [reportError])
  const challengeError = useCallback(() => setNotice('CHALLENGE_UNAVAILABLE'), [])

  return {
    bundle, loading, driver, notice, busy, challengeSiteKey, challengeVerifying, refresh,
    pause: () => safeAction(() => setRoomStatus('paused')),
    resume: () => safeAction(() => setRoomStatus('running')),
    stop,
    sendUserMessage,
    continueRun: (limit: TurnLimit) => safeAction(() => continueRun(limit)),
    retry: (message: LocalMessage) => safeAction(() => retry(message)),
    skip: (message: LocalMessage) => safeAction(() => skip(message)),
    keepPartial,
    saveAgents: (agents: LocalAgent[]) => safeAction(() => saveAgents(agents)),
    verifyChallenge,
    challengeError,
  }
}
