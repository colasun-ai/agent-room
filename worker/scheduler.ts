import type { FairnessState, RoomRecord, RosterEntry } from './types'

export const BOOST_CAP = 2

export interface SpeakerChoice {
  agentId: string
  boosted: boolean
  reason: 'round-robin' | 'agent-mention' | 'user-address' | 'starvation'
}

function enabledRoster(roster: RosterEntry[]): RosterEntry[] {
  return roster.filter((entry) => entry.enabled)
}

function cursorTarget(room: RoomRecord, enabled: RosterEntry[]): RosterEntry {
  for (let offset = 0; offset < room.roster.length; offset += 1) {
    const candidate = room.roster[(room.cursorIndex + offset) % room.roster.length]
    if (candidate?.enabled) return candidate
  }
  return enabled[0]
}

function exactAddress(value: string | undefined, roster: RosterEntry[]): string | undefined {
  if (!value) return undefined
  const trimmed = value.trimStart()
  if (!trimmed.startsWith('@')) return undefined
  const lower = trimmed.slice(1).normalize('NFKC').toLocaleLowerCase('en-US')
  return roster
    .map((entry) => entry.nameKey)
    .sort((a, b) => b.length - a.length)
    .find((name) => lower === name || lower.startsWith(`${name} `) || lower.startsWith(`${name}:`) || lower.startsWith(`${name}，`) || lower.startsWith(`${name},`))
}

export function chooseSpeaker(room: RoomRecord, userAddress?: string, retrySpeakerId?: string): SpeakerChoice {
  const enabled = enabledRoster(room.roster)
  if (enabled.length < 1) throw new Error('NO_ENABLED_AGENTS')
  if (retrySpeakerId && enabled.some((entry) => entry.agentId === retrySpeakerId)) {
    return { agentId: retrySpeakerId, boosted: retrySpeakerId !== cursorTarget(room, enabled).agentId, reason: 'round-robin' }
  }

  const normal = cursorTarget(room, enabled)
  const starvationThreshold = Math.max(4, enabled.length * 2)
  const starved = enabled
    .filter((entry) => (room.fairness.turnsSinceSpoke[entry.agentId] ?? 0) >= starvationThreshold)
    .sort((a, b) => (room.fairness.turnsSinceSpoke[b.agentId] ?? 0) - (room.fairness.turnsSinceSpoke[a.agentId] ?? 0))[0]
  if (starved) return { agentId: starved.agentId, boosted: false, reason: 'starvation' }
  if (room.fairness.consecutiveBoosts >= BOOST_CAP) return { agentId: normal.agentId, boosted: false, reason: 'round-robin' }

  const addressedName = exactAddress(userAddress, enabled)
  const addressed = enabled.find((entry) => entry.nameKey === addressedName)
  if (addressed && addressed.agentId !== room.lastCompletedSpeakerId) {
    return { agentId: addressed.agentId, boosted: addressed.agentId !== normal.agentId, reason: 'user-address' }
  }
  const mentioned = room.lastAcceptedMentions
    .map((name) => enabled.find((entry) => entry.nameKey === name))
    .find((entry) => entry && entry.agentId !== room.lastCompletedSpeakerId)
  if (mentioned) return { agentId: mentioned.agentId, boosted: mentioned.agentId !== normal.agentId, reason: 'agent-mention' }
  return { agentId: normal.agentId, boosted: false, reason: 'round-robin' }
}

export function advanceAfterCompletion(room: RoomRecord, choice: SpeakerChoice, mentions: string[]): RoomRecord {
  const roster = room.roster
  const chosenIndex = roster.findIndex((entry) => entry.agentId === choice.agentId)
  let cursorIndex = room.cursorIndex
  const current = cursorTarget(room, enabledRoster(roster))
  if (!choice.boosted || current.agentId === choice.agentId) cursorIndex = (chosenIndex + 1) % roster.length

  const turnsSinceSpoke = Object.fromEntries(
    roster.map((entry) => [entry.agentId, entry.agentId === choice.agentId ? 0 : (room.fairness.turnsSinceSpoke[entry.agentId] ?? 0) + 1]),
  )
  const runTurnsCompleted = room.runTurnsCompleted + 1
  return {
    ...room,
    cursorIndex,
    runTurnsCompleted,
    totalTurnsCompleted: room.totalTurnsCompleted + 1,
    status: runTurnsCompleted >= room.runTurnLimit ? 'finished' : room.status,
    lastCompletedSpeakerId: choice.agentId,
    lastAcceptedMentions: mentions,
    fairness: { turnsSinceSpoke, consecutiveBoosts: choice.boosted ? room.fairness.consecutiveBoosts + 1 : 0 },
    activeLease: undefined,
    controlRevision: room.controlRevision + 1,
  }
}

export function parseMentions(content: string, roster: RosterEntry[], speakerId?: string): string[] {
  const results: string[] = []
  const enabled = roster.filter((entry) => entry.enabled)
  const byName = new Map(enabled.map((entry) => [entry.nameKey, entry]))
  const pattern = /(^|[^\p{L}\p{N}_])@([\p{L}\p{N}_-]+(?:[ ]+[\p{L}\p{N}_-]+)*)/gu
  for (const match of content.normalize('NFKC').toLocaleLowerCase('en-US').matchAll(pattern)) {
    const raw = match[2]
    const names = [...byName.keys()].sort((a, b) => b.length - a.length)
    const name = names.find((candidate) => raw === candidate || raw.startsWith(`${candidate} `))
    const target = name ? byName.get(name) : undefined
    if (target && target.agentId !== speakerId && !results.includes(target.nameKey)) results.push(target.nameKey)
  }
  return results
}

export function initialFairness(roster: RosterEntry[]): FairnessState {
  return { turnsSinceSpoke: Object.fromEntries(roster.map((entry) => [entry.agentId, 0])), consecutiveBoosts: 0 }
}
