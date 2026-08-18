import { readFile } from 'node:fs/promises'

const state = JSON.parse(await readFile(new URL('../../.agent-runtime/state.json', import.meta.url), 'utf8'))
const ids = new Set(state.tasks.map((task) => task.id))
const errors = []
if (ids.size !== state.tasks.length) errors.push('task ids are not unique')
for (const task of state.tasks) {
  for (const dependency of task.dependsOn ?? []) {
    if (!ids.has(dependency)) errors.push(`${task.id} has unknown dependency ${dependency}`)
  }
}
if (state.openIssues.some((issue) => ['BLOCKER', 'MAJOR'].includes(issue.severity))) {
  errors.push('release-blocking issues remain')
}
if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
console.log('AgentRuntime gate PASS')

