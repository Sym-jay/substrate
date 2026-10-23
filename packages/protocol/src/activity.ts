import { z } from 'zod'
import { Agent } from './terminal.ts'

// What happens inside a VM that matters for alerts and auto-pause. Agent hooks
// report to guestd with `substrate-event` (see images/guest/customize-rootfs.sh);
// hostd polls guestd for the result.

// start: a prompt was submitted. stop: the agent finished its turn.
// attention: the agent is waiting on you, e.g. for a permission.
export const AgentEventKind = z.enum(['start', 'stop', 'attention'])
export type AgentEventKind = z.infer<typeof AgentEventKind>

// substrate-event → guestd, over a Unix socket inside the VM. `payload` is
// whatever the agent handed its hook, as it was.
export const AgentEventReport = z.object({
  agent: Agent,
  kind: AgentEventKind,
  payload: z.unknown().optional(),
})
export type AgentEventReport = z.infer<typeof AgentEventReport>

export const AgentEvent = z.object({
  // Counts up from 1 each time guestd starts.
  seq: z.number().int(),
  at: z.string(),
  agent: Agent,
  kind: AgentEventKind,
  // Why the agent wants attention, e.g. "Claude needs your permission to use Bash".
  message: z.string().nullable(),
  // How long nobody had typed in any of the VM's terminals when it happened;
  // null if nobody has since guestd started.
  inputIdleMs: z.number().nullable(),
})
export type AgentEvent = z.infer<typeof AgentEvent>

// guestd → hostd.
export const GuestActivity = z.object({
  // New each time guestd starts, which restarts `seq`.
  bootId: z.string(),
  // Since the last terminal input or output, agent event, or busy CPU.
  idleMs: z.number(),
  // The most recent events, oldest first.
  events: AgentEvent.array(),
})
export type GuestActivity = z.infer<typeof GuestActivity>
