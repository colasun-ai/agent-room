export type CoordinationMessage = { type: 'changed' | 'driver'; roomId: string; source: string }

export class RoomCoordinator {
  private channel?: BroadcastChannel
  private releaseLock?: () => void
  private readonly source = crypto.randomUUID()
  private driver = false
  private closed = false

  constructor(private roomId: string, private onMessage: (message: CoordinationMessage) => void) {
    if ('BroadcastChannel' in window) {
      this.channel = new BroadcastChannel(`agentroom:${roomId}`)
      this.channel.onmessage = ({ data }) => { if (data?.source !== this.source && data?.roomId === roomId) onMessage(data as CoordinationMessage) }
    }
  }

  async acquire(): Promise<boolean> {
    if (!navigator.locks) { this.driver = true; this.broadcast('driver'); return true }
    return new Promise<boolean>((resolve) => {
      void navigator.locks.request(`agentroom:${this.roomId}`, { ifAvailable: true }, async (lock) => {
        if (!lock || this.closed) { resolve(false); return }
        this.driver = true; this.broadcast('driver'); resolve(true)
        await new Promise<void>((release) => { this.releaseLock = release })
        this.driver = false
      })
    })
  }

  isDriver(): boolean { return this.driver }
  changed(): void { this.broadcast('changed') }
  private broadcast(type: CoordinationMessage['type']): void { this.channel?.postMessage({ type, roomId: this.roomId, source: this.source } satisfies CoordinationMessage) }
  close(): void { this.closed = true; this.releaseLock?.(); this.channel?.close() }
}
