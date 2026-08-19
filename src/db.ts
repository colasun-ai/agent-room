import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { LocalAgent, LocalMessage, LocalRoom, LocalRun, RoomBundle } from './model'

interface AgentRoomDB extends DBSchema {
  rooms: { key: string; value: LocalRoom; indexes: { 'by-updated': number } }
  runs: { key: string; value: LocalRun; indexes: { 'by-room': string } }
  agents: { key: string; value: LocalAgent; indexes: { 'by-room': string } }
  messages: { key: string; value: LocalMessage; indexes: { 'by-room': string; 'by-created': number } }
}

let database: Promise<IDBPDatabase<AgentRoomDB>> | undefined

function getDatabase(): Promise<IDBPDatabase<AgentRoomDB>> {
  database ??= openDB<AgentRoomDB>('agent-room', 1, {
    upgrade(db) {
      const rooms = db.createObjectStore('rooms', { keyPath: 'id' })
      rooms.createIndex('by-updated', 'updatedAt')
      const runs = db.createObjectStore('runs', { keyPath: 'id' })
      runs.createIndex('by-room', 'roomId')
      const agents = db.createObjectStore('agents', { keyPath: 'id' })
      agents.createIndex('by-room', 'roomId')
      const messages = db.createObjectStore('messages', { keyPath: 'id' })
      messages.createIndex('by-room', 'roomId')
      messages.createIndex('by-created', 'createdAt')
    },
    blocked() {
      window.dispatchEvent(new CustomEvent('agentroom:database-blocked'))
    },
  })
  return database
}

export async function saveNewRoom(room: LocalRoom, run: LocalRun, agents: LocalAgent[]): Promise<void> {
  const db = await getDatabase()
  const tx = db.transaction(['rooms', 'runs', 'agents'], 'readwrite')
  await Promise.all([tx.objectStore('rooms').put(room), tx.objectStore('runs').put(run), ...agents.map((agent) => tx.objectStore('agents').put(agent)), tx.done])
}

export async function listRooms(): Promise<LocalRoom[]> {
  const rooms = await (await getDatabase()).getAll('rooms')
  return rooms.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function loadRoom(roomId: string): Promise<RoomBundle | undefined> {
  const db = await getDatabase()
  const [room, runs, agents, messages] = await Promise.all([
    db.get('rooms', roomId), db.getAllFromIndex('runs', 'by-room', roomId), db.getAllFromIndex('agents', 'by-room', roomId), db.getAllFromIndex('messages', 'by-room', roomId),
  ])
  if (!room) return undefined
  return {
    room,
    runs: runs.sort((a, b) => a.createdAt - b.createdAt),
    agents,
    messages: messages.sort((a, b) => a.createdAt - b.createdAt),
  }
}

export async function putRoom(room: LocalRoom): Promise<void> { await (await getDatabase()).put('rooms', room) }
export async function putRun(run: LocalRun): Promise<void> { await (await getDatabase()).put('runs', run) }
export async function putMessage(message: LocalMessage): Promise<void> { await (await getDatabase()).put('messages', message) }

export async function putAgents(agents: LocalAgent[]): Promise<void> {
  const db = await getDatabase()
  const tx = db.transaction('agents', 'readwrite')
  await Promise.all([...agents.map((agent) => tx.store.put(agent)), tx.done])
}

export async function deleteRoomCascade(roomId: string): Promise<void> {
  const db = await getDatabase()
  const tx = db.transaction(['rooms', 'runs', 'agents', 'messages'], 'readwrite')
  await tx.objectStore('rooms').delete(roomId)
  for (const storeName of ['runs', 'agents', 'messages'] as const) {
    const store = tx.objectStore(storeName)
    let cursor = await store.index('by-room').openCursor(IDBKeyRange.only(roomId))
    while (cursor) { await cursor.delete(); cursor = await cursor.continue() }
  }
  await tx.done
}

export async function clearAllLocalData(): Promise<void> {
  const db = await getDatabase()
  const tx = db.transaction(['rooms', 'runs', 'agents', 'messages'], 'readwrite')
  await Promise.all((['rooms', 'runs', 'agents', 'messages'] as const).map((name) => tx.objectStore(name).clear()))
  await tx.done
}

export async function recoverInterruptedMessages(): Promise<number> {
  const db = await getDatabase()
  const tx = db.transaction(['messages', 'rooms'], 'readwrite')
  let recovered = 0
  let cursor = await tx.objectStore('messages').openCursor()
  const affectedRooms = new Set<string>()
  while (cursor) {
    const message = cursor.value
    if (['pending', 'waiting', 'thinking', 'streaming'].includes(message.status)) {
      await cursor.update({ ...message, status: message.content ? 'interrupted' : 'error', errorCode: 'REFRESH_INTERRUPTED', updatedAt: Date.now() })
      affectedRooms.add(message.roomId)
      recovered += 1
    }
    cursor = await cursor.continue()
  }
  for (const roomId of affectedRooms) {
    const room = await tx.objectStore('rooms').get(roomId)
    if (room?.status === 'running') await tx.objectStore('rooms').put({ ...room, status: 'paused', updatedAt: Date.now() })
  }
  await tx.done
  return recovered
}

export function createStreamingWriter(initial: LocalMessage, onFlush?: (message: LocalMessage) => void) {
  let current = initial
  let timer: number | undefined
  let lastLength = initial.content.length
  const flush = async () => {
    if (timer) window.clearTimeout(timer)
    timer = undefined
    lastLength = current.content.length
    await putMessage(current)
    onFlush?.(current)
  }
  return {
    update(next: LocalMessage) {
      current = next
      if (current.content.length - lastLength >= 160) void flush()
      else if (!timer) timer = window.setTimeout(() => void flush(), 350)
    },
    async finish(next?: LocalMessage) { if (next) current = next; await flush() },
    snapshot() { return current },
  }
}
