export interface QueueTicket<T = unknown> {
  id: string
  sessionId: string
  roomId: string
  value: T
}

export class FairQueue<T = unknown> {
  private readonly sessions = new Map<string, Map<string, QueueTicket<T>[]>>()
  private sessionCursor = 0
  private readonly roomCursors = new Map<string, number>()

  enqueue(ticket: QueueTicket<T>): void {
    const rooms = this.sessions.get(ticket.sessionId) ?? new Map<string, QueueTicket<T>[]>()
    const queue = rooms.get(ticket.roomId) ?? []
    queue.push(ticket)
    rooms.set(ticket.roomId, queue)
    this.sessions.set(ticket.sessionId, rooms)
  }

  remove(id: string): QueueTicket<T> | undefined {
    for (const [sessionId, rooms] of this.sessions) {
      for (const [roomId, tickets] of rooms) {
        const index = tickets.findIndex((ticket) => ticket.id === id)
        if (index >= 0) {
          const [removed] = tickets.splice(index, 1)
          if (tickets.length === 0) rooms.delete(roomId)
          if (rooms.size === 0) this.sessions.delete(sessionId)
          return removed
        }
      }
    }
    return undefined
  }

  dequeue(): QueueTicket<T> | undefined {
    const sessionIds = [...this.sessions.keys()]
    if (sessionIds.length === 0) return undefined
    this.sessionCursor %= sessionIds.length
    const sessionId = sessionIds[this.sessionCursor]
    this.sessionCursor = (this.sessionCursor + 1) % sessionIds.length
    const rooms = this.sessions.get(sessionId)!
    const roomIds = [...rooms.keys()]
    const cursor = (this.roomCursors.get(sessionId) ?? 0) % roomIds.length
    const roomId = roomIds[cursor]
    this.roomCursors.set(sessionId, (cursor + 1) % roomIds.length)
    const tickets = rooms.get(roomId)!
    const ticket = tickets.shift()
    if (tickets.length === 0) rooms.delete(roomId)
    if (rooms.size === 0) this.sessions.delete(sessionId)
    return ticket
  }

  get size(): number {
    let count = 0
    for (const rooms of this.sessions.values()) for (const tickets of rooms.values()) count += tickets.length
    return count
  }
}

export class RollingWindow {
  private timestamps: number[] = []
  constructor(private readonly limit: number, private readonly windowMs: number) {}

  tryTake(now: number): boolean {
    this.timestamps = this.timestamps.filter((timestamp) => timestamp > now - this.windowMs)
    if (this.timestamps.length >= this.limit) return false
    this.timestamps.push(now)
    return true
  }

  nextAt(now: number): number {
    this.timestamps = this.timestamps.filter((timestamp) => timestamp > now - this.windowMs)
    return this.timestamps.length < this.limit ? now : this.timestamps[0] + this.windowMs + 1
  }
}

export function utcDayStart(now: number): number {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

export function effectiveDailyAttemptLimit(globalLimit: number, explicitLimit?: number): number {
  const evidenceBasedDefault = 16_000
  return Math.max(1, Math.min(24_000, globalLimit, explicitLimit ?? evidenceBasedDefault))
}
