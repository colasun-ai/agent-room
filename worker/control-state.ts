import type { ControlAction } from '../shared/protocol'
import type { RoomRecord } from './types'

export function transitionControl(room: RoomRecord, action: ControlAction, now: number): RoomRecord {
  if (action.controlRevision !== room.controlRevision) throw new Error('REVISION_CONFLICT')
  if (room.activeLease && room.activeLease.expiresAt > now) throw new Error('ROOM_BUSY')
  const next: RoomRecord = JSON.parse(JSON.stringify(room)) as RoomRecord
  if (action.action === 'pause') next.status = 'paused'
  else if (action.action === 'resume') {
    if (next.runTurnsCompleted >= next.runTurnLimit) throw new Error('RUN_COMPLETE')
    next.status = 'running'
  } else if (action.action === 'continue') {
    if (next.runTurnsCompleted < next.runTurnLimit) throw new Error('RUN_INCOMPLETE')
    next.activeRunId = action.runId
    next.runTurnLimit = action.turnLimit
    next.runTurnsCompleted = 0
    next.status = 'running'
    next.failedTurns = {}
  } else {
    next.roster = action.roster
    next.cursorIndex %= next.roster.length
    next.fairness.turnsSinceSpoke = Object.fromEntries(next.roster.map((entry) => [entry.agentId, next.fairness.turnsSinceSpoke[entry.agentId] ?? 0]))
  }
  next.controlRevision += 1
  next.updatedAt = now
  next.expiresAt = now + 12 * 60 * 60_000
  return next
}
