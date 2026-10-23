import { Agents, type AgentEvent, type GuestActivity, type Vm } from '@substrate/protocol'
import { message } from './errors.ts'
import type { Alert, Notify } from './notify.ts'
import type { VmService } from './vms.ts'

const agentNames: Record<keyof typeof Agents, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  agy: 'Antigravity',
}

// How long a running VM's guest agent may go without answering before an alert.
const SILENT_ALERT_MS = 2 * 60_000

type Options = {
  vms: Pick<VmService, 'list' | 'guest' | 'pause'>
  notify: Notify
  quietMs: number
  now?: () => number
}

// Watches running VMs through their guest agents. It forwards agents' alerts,
// pauses a VM once it has been idle for its autoPauseMinutes or awake for its
// maxAwakeHours, and says when a guest stops answering.
export class AutoPause {
  private readonly vms: Options['vms']
  private readonly notify: Notify
  private readonly quietMs: number
  private readonly now: () => number
  private readonly started: number
  // The last event forwarded per VM, so each alert goes out once.
  private cursors = new Map<string, { bootId: string; seq: number }>()
  private pausing = new Set<string>()
  // Running VMs whose guest agent isn't answering, since when, and whether we said so.
  private silentSince = new Map<string, number>()
  private warned = new Set<string>()
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
      for (const id of this.silentSince.keys()) {
        if (!vms.some((vm) => vm.id === id && vm.state === 'running')) {
          this.silentSince.delete(id)
          this.warned.delete(id)
        }
      }
      await Promise.all(vms.filter((vm) => vm.state === 'running').map((vm) => this.check(vm)))
    } catch (err) {
      console.error(`auto-pause: ${message(err)}`)
    } finally {
      this.running = false
    }
  }

  private async check(vm: Vm) {
    // A stuck agent can't keep a VM awake forever.
    const hours = vm.maxAwakeHours
    const awakeSince = Date.parse(vm.awakeSince ?? '')
    if (hours != null && awakeSince && this.now() - awakeSince >= hours * 3_600_000) {
      return this.pause(vm, `awake for ${hours} h`, {
        vm, title: `${vm.name} paused after ${hours} h`, priority: 'default', tags: ['hourglass'],
        message: `It had been running for ${hours} hours, its limit, so it was saved and paused. Type in its terminal to wake it, or raise its limit.`,
      })
    }

    let guest: Awaited<ReturnType<Options['vms']['guest']>>
    try {
      guest = await this.vms.guest(vm.id)
    } catch {
      return // It stopped or started pausing meanwhile; try next time.
    }
    let activity: GuestActivity | null
    try {
      activity = await guest.activity()
    } catch {
      return this.unanswered(vm)
    }
    this.silentSince.delete(vm.id)
    this.warned.delete(vm.id)
    // An image from before M4 doesn't report activity.
    if (!activity) return
    await this.forward(vm, activity)

    const minutes = vm.autoPauseMinutes
    if (minutes == null) return
    const limitMs = minutes * 60_000
    // A resumed guest's idle time may include the time it spent paused, so
    // each boot or resume (or hostd starting) gets a full idle period too.
    const awakeMs = this.now() - Math.max(this.started, awakeSince || 0)
    if (activity.idleMs < limitMs || awakeMs < limitMs) return
    this.pause(vm, `idle for ${Math.round(activity.idleMs / 1000)} s`, {
      vm, title: `${vm.name} paused`, priority: 'low', tags: ['zzz'],
      message: `Idle for ${minutes} min, so it was saved and paused. Type in its terminal to wake it.`,
    })
  }

  private pause(vm: Vm, why: string, alert: Alert) {
    if (this.pausing.has(vm.id)) return
    this.pausing.add(vm.id)
    console.log(`auto-pause: ${vm.id} ${why}; pausing`)
    void this.vms
      .pause(vm.id)
      .then(
        () => this.notify(alert),
        (err) => console.error(`auto-pause: couldn't pause ${vm.id}: ${message(err)}`),
      )
      .finally(() => this.pausing.delete(vm.id))
  }

  // A running VM whose guest agent stopped answering: out of memory, or hung.
  private unanswered(vm: Vm) {
    const since = this.silentSince.get(vm.id) ?? this.now()
    this.silentSince.set(vm.id, since)
    if (this.now() - since < SILENT_ALERT_MS || this.warned.has(vm.id)) return
    this.warned.add(vm.id)
    void this.notify({
      vm, title: `${vm.name} isn't responding`, priority: 'high', tags: ['warning'],
      message: `Its guest agent hasn't answered for ${SILENT_ALERT_MS / 60_000} minutes. It may be out of memory. Open it, or stop and start it.`,
    })
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
