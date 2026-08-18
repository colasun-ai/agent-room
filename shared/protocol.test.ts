import { describe, expect, it } from 'vitest'
import { isTurnLimit, normalizeAgentName } from './protocol'

describe('protocol primitives', () => {
  it('normalizes agent names deterministically', () => {
    expect(normalizeAgentName('  ＭＡＹＡ  ')).toBe('maya')
  })

  it('accepts only contract turn limits', () => {
    expect([6, 12, 20].every(isTurnLimit)).toBe(true)
    expect(isTurnLimit(10)).toBe(false)
  })
})

