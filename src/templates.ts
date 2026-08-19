import { normalizeAgentName, type TurnLimit } from '../shared/protocol'
import type { LocalAgent } from './model'

export type TemplateId = 'startup' | 'debate' | 'build'

export interface RoomTemplate {
  id: TemplateId
  icon: string
  title: string
  description: string
  topic: string
  turnLimit: TurnLimit
  agents: Array<Omit<LocalAgent, 'id' | 'roomId' | 'normalizedName'>>
}

export const ROOM_TEMPLATES: readonly RoomTemplate[] = [
  {
    id: 'startup', icon: '✦', title: 'Startup Team', description: 'Shape a product with a pragmatic founding team.',
    topic: 'Turn a rough product idea into a focused first release: identify the user, sharpest problem, smallest useful scope, and key technical risks.', turnLimit: 12,
    agents: [
      { name: 'Alex', role: 'Product Manager', avatar: '🧭', personality: 'Clear, optimistic, and ruthlessly focused on user value.', goal: 'Find the smallest product that solves a real user problem.', enabled: true, temperature: 0.65 },
      { name: 'Maya', role: 'Senior Engineer', avatar: '⚙️', personality: 'Practical, precise, and candid about technical trade-offs.', goal: 'Turn the product direction into a resilient, achievable technical plan.', enabled: true, temperature: 0.55 },
      { name: 'Nova', role: 'Critic', avatar: '◈', personality: 'Constructively skeptical and alert to hidden assumptions.', goal: 'Pressure-test the plan before expensive mistakes are made.', enabled: true, temperature: 0.75 },
    ],
  },
  {
    id: 'debate', icon: '↔', title: 'Debate', description: 'Explore a difficult choice from opposing views.',
    topic: 'Debate whether remote-first teams create better long-term companies. Find the strongest evidence and a nuanced conclusion.', turnLimit: 12,
    agents: [
      { name: 'Aria', role: 'Affirmative', avatar: '☀️', personality: 'Evidence-led, energetic, and charitable to opposing arguments.', goal: 'Make the strongest case for the proposition.', enabled: true, temperature: 0.75 },
      { name: 'Theo', role: 'Negative', avatar: '🌒', personality: 'Analytical, measured, and skilled at identifying exceptions.', goal: 'Expose weaknesses and make the strongest counter-case.', enabled: true, temperature: 0.75 },
      { name: 'Sage', role: 'Moderator', avatar: '⚖️', personality: 'Neutral, concise, and attentive to common ground.', goal: 'Clarify claims, prevent repetition, and synthesize a fair conclusion.', enabled: true, temperature: 0.5 },
    ],
  },
  {
    id: 'build', icon: '⌁', title: 'Build Something', description: 'Turn an idea into an actionable build plan.',
    topic: 'Design and plan a small, delightful software project that can be shipped in one week.', turnLimit: 6,
    agents: [
      { name: 'Pia', role: 'Designer', avatar: '✎', personality: 'Curious, humane, and attentive to interaction details.', goal: 'Define an experience people understand and enjoy immediately.', enabled: true, temperature: 0.8 },
      { name: 'Jules', role: 'Builder', avatar: '⌘', personality: 'Fast-moving, grounded, and biased toward simple implementation.', goal: 'Produce a concrete scope and build sequence with few dependencies.', enabled: true, temperature: 0.55 },
      { name: 'Remy', role: 'Reviewer', avatar: '◎', personality: 'Calm, exacting, and focused on quality and failure modes.', goal: 'Make the result coherent, testable, and safe to ship.', enabled: true, temperature: 0.6 },
    ],
  },
] as const

export function instantiateTemplate(templateId: TemplateId, roomId: string): LocalAgent[] {
  const template = ROOM_TEMPLATES.find((item) => item.id === templateId) ?? ROOM_TEMPLATES[0]
  return template.agents.map((agent) => ({ ...agent, id: crypto.randomUUID(), roomId, normalizedName: normalizeAgentName(agent.name) }))
}
