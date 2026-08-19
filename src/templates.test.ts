import { describe, expect, it } from 'vitest'
import { ROOM_TEMPLATES, instantiateTemplate } from './templates'

describe('room templates', () => {
  it('ships the three required local-only templates', () => {
    expect(ROOM_TEMPLATES.map((template) => template.title)).toEqual(['Startup Team', 'Debate', 'Build Something'])
    expect(ROOM_TEMPLATES.every((template) => template.agents.length === 3)).toBe(true)
  })

  it('instantiates stable profile fields without provider controls', () => {
    const agents = instantiateTemplate('startup', 'room-1')
    expect(agents.map((agent) => [agent.name, agent.role])).toEqual([
      ['Alex', 'Product Manager'], ['Maya', 'Senior Engineer'], ['Nova', 'Critic'],
    ])
    expect(agents.every((agent) => agent.roomId === 'room-1' && agent.normalizedName && agent.goal && agent.personality)).toBe(true)
    expect(JSON.stringify(agents)).not.toMatch(/model|systemPromptOverride|tool/i)
  })
})
