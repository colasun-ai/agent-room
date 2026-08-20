import { describe, expect, it } from 'vitest'
import { effectiveDailyAttemptLimit, FairQueue, RollingWindow, utcDayStart } from './quota'

describe('durable quota primitives', () => {
  it('never permits more than 28 timestamps in an arbitrary 60 second window', () => {
    const window = new RollingWindow(28, 60_000)
    expect(Array.from({ length: 28 }, (_, index) => window.tryTake(index * 100)).every(Boolean)).toBe(true)
    expect(window.tryTake(59_999)).toBe(false)
    expect(window.tryTake(60_001)).toBe(true)
  })

  it('dequeues by session and then room fairness', () => {
    const queue = new FairQueue<number>()
    queue.enqueue({ id: '1', sessionId: 's1', roomId: 'r1', value: 1 })
    queue.enqueue({ id: '2', sessionId: 's1', roomId: 'r2', value: 2 })
    queue.enqueue({ id: '3', sessionId: 's2', roomId: 'r3', value: 3 })
    queue.enqueue({ id: '4', sessionId: 's1', roomId: 'r1', value: 4 })
    expect([queue.dequeue()?.value, queue.dequeue()?.value, queue.dequeue()?.value, queue.dequeue()?.value]).toEqual([1, 3, 2, 4])
  })

  it('removes every matching queued ticket without disturbing the remainder', () => {
    const queue = new FairQueue<number>()
    queue.enqueue({ id: '1', sessionId: 's1', roomId: 'r1', value: 1 })
    queue.enqueue({ id: '2', sessionId: 's1', roomId: 'r1', value: 2 })
    queue.enqueue({ id: '3', sessionId: 's2', roomId: 'r2', value: 3 })
    expect(queue.removeWhere((ticket) => ticket.sessionId === 's1').map((ticket) => ticket.value).sort()).toEqual([1, 2])
    expect(queue.size).toBe(1)
    expect(queue.dequeue()?.value).toBe(3)
  })

  it('uses a UTC daily boundary', () => expect(utcDayStart(Date.parse('2026-08-18T23:59:59Z'))).toBe(Date.parse('2026-08-18T00:00:00Z')))

  it('reserves free-plan control capacity unless an audited lower effective cap is configured', () => {
    expect(effectiveDailyAttemptLimit(24_000)).toBe(16_000)
    expect(effectiveDailyAttemptLimit(24_000, 12_000)).toBe(12_000)
    expect(effectiveDailyAttemptLimit(30_000, 26_000)).toBe(24_000)
  })
})
