import { readFile } from 'node:fs/promises'

const state = JSON.parse(await readFile(new URL('../../.agent-runtime/state.json', import.meta.url), 'utf8'))
const counts = Object.groupBy(state.tasks, (task) => task.status)
console.log(JSON.stringify({
  phase: state.phase,
  releaseClass: state.releaseClass,
  deploymentState: state.deploymentState,
  tasks: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value.length])),
  gates: state.gates,
  openIssues: state.openIssues,
}, null, 2))

