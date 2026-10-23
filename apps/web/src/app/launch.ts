import { VmSizes, type Agent, type AgentMode, type VmSizeName } from '@substrate/protocol'
import { workspaceApi } from '../workspaces/api.ts'

export type LaunchConfig = {
  name?: string
  size: VmSizeName
  diskGib: number
  repository?: string
  // null: a plain shell.
  agent: Agent | null
  mode: AgentMode
  autoPauseMinutes: number | null | 'default'
}

const adjectives = ['quiet', 'bright', 'swift', 'calm', 'bold', 'keen', 'brisk', 'lucid', 'steady', 'nimble', 'polished', 'silver']
const nouns = ['falcon', 'harbor', 'comet', 'ridge', 'forge', 'meadow', 'atlas', 'quartz', 'cedar', 'beacon', 'summit', 'delta']
const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)]!
export const randomName = () => `${pick(adjectives)}-${pick(nouns)}-${Math.floor(Math.random() * 90 + 10)}`

export const describeSize = (size: VmSizeName) => `${VmSizes[size].vcpus} vCPU · ${VmSizes[size].memMib / 1024} GB`

// Creates a workspace and opens its first session: the agent, or a shell.
// Returns where to go next.
export async function launch(config: LaunchConfig) {
  const vm = await workspaceApi.create({ name: config.name || randomName(), size: config.size, diskGib: config.diskGib, repository: config.repository || undefined })
  if (vm.lastError) return { vm, sessionId: null, warning: vm.lastError }
  let warning: string | null = null
  if (config.autoPauseMinutes !== 'default') {
    await workspaceApi.update(vm.id, { autoPauseMinutes: config.autoPauseMinutes }).catch(() => { warning = 'Its auto-pause setting couldn’t be applied.' })
  }
  try {
    const session = await workspaceApi.createSession(vm.id, config.agent ? { agent: config.agent, mode: config.mode } : {})
    return { vm, sessionId: session.id, warning }
  } catch (error) {
    return { vm, sessionId: null, warning: `The workspace is up, but its ${config.agent ? 'agent' : 'shell'} didn’t start: ${error instanceof Error ? error.message : 'unknown error'}` }
  }
}
