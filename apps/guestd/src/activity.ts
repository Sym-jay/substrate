import type { AgentEvent, GuestActivity } from '@substrate/protocol'
import { readFile } from 'node:fs/promises'

const MAX_EVENTS = 50

// When the VM was last active, and what its agents reported. Times are
// monotonic, so a change to the guest's clock can't make it look idle.
export class Activity {
  readonly bootId = crypto.randomUUID()
  private lastActive: number
  private lastInput: number | null = null
  private seq = 0
  private events: AgentEvent[] = []

  constructor(private readonly now = () => performance.now()) {
    this.lastActive = now()
  }

  // Terminal output, a browser attaching, or busy CPUs.
  touch() {
    this.lastActive = this.now()
  }

  // Someone typed in a terminal.
  input() {
    this.lastInput = this.lastActive = this.now()
  }

  record(event: Pick<AgentEvent, 'agent' | 'kind' | 'message'>) {
    const now = this.now()
    this.lastActive = now
    const inputIdleMs = this.lastInput === null ? null : Math.round(now - this.lastInput)
    this.events.push({ ...event, seq: ++this.seq, at: new Date().toISOString(), inputIdleMs })
    if (this.events.length > MAX_EVENTS) this.events.shift()
  }

  report(): GuestActivity {
    return { bootId: this.bootId, idleMs: Math.round(this.now() - this.lastActive), events: this.events }
  }
}

// Averaged over a sample, the VM counts as busy above this many CPUs' worth.
// Idle daemons (Docker, a dev server) stay well under it.
export const BUSY_CPUS = 0.2

// Returns how many CPUs' worth of work ran since the previous call, from
// /proc/stat. Time stolen by the host doesn't count; waiting on disk does.
export function cpuSampler(read = () => readFile('/proc/stat', 'utf8')) {
  let previous: { busy: number; total: number } | null = null
  return async () => {
    const text = await read()
    const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = text
      .slice(0, text.indexOf('\n'))
      .trim()
      .split(/\s+/)
      .slice(1)
      .map(Number)
    const cpus = text.match(/^cpu\d+ /gm)?.length ?? 1
    const total = user + nice + system + idle + iowait + irq + softirq + steal
    const busy = total - idle - steal
    const last = previous
    previous = { busy, total }
    if (!last || total <= last.total) return 0
    return ((busy - last.busy) / (total - last.total)) * cpus
  }
}
