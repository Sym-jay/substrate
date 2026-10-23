import { Agents, type AgentEvent, type GuestActivity, type Vm } from '@substrate/protocol'
import type { Alert, Notify } from './notify.ts'
import type { VmService } from './vms.ts'

const agentNames: Record<keyof typeof Agents, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  agy: 'Antigravity',
}

type Options = {
  vms: Pick<VmService, 'list' | 'guest' | 'pause'>
  notify: Notify
  quietMs: number
  now?: () => number
}

// Watches running VMs through their guest agents. It forwards agents' alerts,
// and pauses a VM once it has been idle for its autoPauseMinutes.
export class AutoPause {
  private readonly vms: Options['vms']
  private readonly notify: Notify
  private readonly quietMs: number
  private readonly now: () => number
  private readonly started: number
  // The last event forwarded per VM, so each alert goes out once.
  private cursors = new Map<string, { bootId: string; seq: number }>()
  private pausing = new Set<string>()
  private running = false

  constructor({ vms, notify, quietMs, now = Date.now }: Options) {
    this.vms = vms
    this.notify = notify
    this.quietMs = quietMs
    this.now = now
    this.started = now()
  }

  start(intervalMs: number) {
    return setInterval(() => void this.tick(), intervalMs)
  }

  // One pass over every running VM. A slow pass makes the next one skip.
  async tick() {
    if (this.running) return
    this.running = true
    try {
      const vms = await this.vms.list()
      for (const id of this.cursors.keys()) if (!vms.some((vm) => vm.id === id)) this.cursors.delete(id)
      await Promise.all(vms.filter((vm) => vm.state === 'running').map((vm) => this.check(vm)))
    } catch (err) {
      console.error('auto-pause:', err)
    } finally {
      this.running = false
    }
  }

  private async check(vm: Vm) {
    let activity: GuestActivity | null
    try {
      activity = await (await this.vms.guest(vm.id)).activity()
    } catch {
      return // It stopped or started pausing meanwhile, or its guest is busy; try next time.
    }
    // An image from before M4 doesn't report activity.
    if (!activity) return
    await this.forward(vm, activity)

    const minutes = vm.autoPauseMinutes
    if (minutes == null || this.pausing.has(vm.id)) return
    const limitMs = minutes * 60_000
    // A resumed guest's idle time may include the time it spent paused, so
    // each boot or resume (or hostd starting) gets a full idle period too.
    const awakeMs = this.now() - Math.max(this.started, Date.parse(vm.awakeSince ?? '') || 0)
    if (activity.idleMs < limitMs || awakeMs < limitMs) return

    this.pausing.add(vm.id)
    console.log(`auto-pause: ${vm.id} idle for ${Math.round(activity.idleMs / 1000)} s; pausing`)
    void this.vms
      .pause(vm.id)
      .then(
        () => this.notify({
          vm, title: `${vm.name} paused`, priority: 'low', tags: ['zzz'],
          message: `Idle for ${minutes} min, so it was saved and paused. Type in its terminal to wake it.`,
        }),
        (err) => console.error(`auto-pause: couldn't pause ${vm.id}:`, err),
      )
      .finally(() => this.pausing.delete(vm.id))
  }

  private async forward(vm: Vm, activity: GuestActivity) {
    const cursor = this.cursors.get(vm.id)
    const latest = activity.events.at(-1)?.seq ?? 0
    this.cursors.set(vm.id, { bootId: activity.bootId, seq: latest })
    // The first look since hostd started: an earlier hostd had its chance at these.
    if (!cursor) return
    const after = cursor.bootId === activity.bootId ? cursor.seq : 0
    for (const event of activity.events) {
      const watching = event.inputIdleMs !== null && event.inputIdleMs < this.quietMs
      if (event.seq <= after || event.kind === 'start' || watching) continue
      await this.notify(alertFor(vm, event))
    }
  }
}

export function alertFor(vm: Pick<Vm, 'id' | 'name'>, event: AgentEvent): Alert {
  const agent = agentNames[event.agent]
  return event.kind === 'attention'
    ? { vm, title: `${agent} needs you`, message: `${vm.name}: ${event.message ?? 'waiting for your input'}`, priority: 'high', tags: ['raising_hand'] }
    : { vm, title: `${agent} finished`, message: `${vm.name} is ready for your next prompt.`, priority: 'default', tags: ['white_check_mark'] }
}
