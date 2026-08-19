import { normalizeAgentName } from '../shared/protocol'
import type { LocalAgent } from './model'

export function parseMentions(content: string, agents: Pick<LocalAgent, 'id' | 'name' | 'normalizedName' | 'enabled'>[]): string[] {
  const enabled = new Map(agents.filter((agent) => agent.enabled).map((agent) => [agent.normalizedName, agent.id]))
  const result = new Set<string>()
  for (const match of content.matchAll(/(^|[^\p{L}\p{N}_])@([\p{L}\p{N}_-]{1,40})/gu)) {
    const id = enabled.get(normalizeAgentName(match[2]))
    if (id) result.add(id)
  }
  return [...result]
}

export function latestUserDirectAddress(content: string, agents: Pick<LocalAgent, 'id' | 'name' | 'normalizedName' | 'enabled'>[]): string | undefined {
  const match = content.trimStart().match(/^@([\p{L}\p{N}_-]{1,40})(?=\s|[,:，：]|$)/u)
  if (!match) return undefined
  return agents.find((agent) => agent.enabled && agent.normalizedName === normalizeAgentName(match[1]))?.id
}
