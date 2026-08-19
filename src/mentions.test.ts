import { describe, expect, it } from 'vitest'
import { latestUserDirectAddress, parseMentions } from './mentions'
import type { LocalAgent } from './model'

const agents = [
  { id: 'maya', name: 'Maya', normalizedName: 'maya', enabled: true },
  { id: 'alex', name: 'Alex', normalizedName: 'alex', enabled: true },
  { id: 'nova', name: 'Nova', normalizedName: 'nova', enabled: false },
] as LocalAgent[]

describe('deterministic mentions', () => {
  it('accepts exact enabled names and de-duplicates them', () => {
    expect(parseMentions('Ask @Maya, then @alex and @Maya again.', agents)).toEqual(['maya', 'alex'])
  })

  it('does not accept unknown, disabled, embedded, or fuzzy addresses', () => {
    expect(parseMentions('email@Maya @Nova @May Maya, what do you think?', agents)).toEqual([])
  })

  it('only treats an explicit leading mention as direct address', () => {
    expect(latestUserDirectAddress('  @Maya: please review this', agents)).toBe('maya')
    expect(latestUserDirectAddress('Could @Maya review this?', agents)).toBeUndefined()
    expect(latestUserDirectAddress('@Nova review this', agents)).toBeUndefined()
  })
})
