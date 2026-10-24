import { DEFAULT_WINDOWS_SIZE, WindowsSizes, type Agent, type AgentMode, type WindowsSizeName } from '@substrate/protocol'
import { workspaceApi } from '../workspaces/api.ts'

export type LaunchConfig = {
  name?: string
  vcpus: number
  memMib: number
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

// What the sliders offer: the API takes any whole value within VmLimits, and
// these are the useful steps of it.
export const vcpuStops = [1, 2, 3, 4, 6, 8, 12, 16]
export const memGibStops = [2, 4, 6, 8, 12, 16, 24, 32, 48, 64]
export const diskGibStops = [8, 16, 32, 64, 128, 256, 512, 1024]
// A Windows workspace's vCPUs and memory: the large size for one from before sizes.
export const windowsSizeOf = (w: { size?: WindowsSizeName | null }) => WindowsSizes[w.size ?? DEFAULT_WINDOWS_SIZE]
export const gibLabel = (gib: number) => (gib >= 1024 ? `${gib / 1024} TB` : `${gib} GB`)

// Creates a workspace and opens its first session: the agent, or a shell.
// Returns where to go next.
export async function launch(config: LaunchConfig) {
  const vm = await workspaceApi.create({ name: config.name || randomName(), vcpus: config.vcpus, memMib: config.memMib, diskGib: config.diskGib, repository: config.repository || undefined })
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
