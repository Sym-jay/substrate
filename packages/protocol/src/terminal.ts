import { z } from 'zod'
import { AgentMode } from './github.ts'

// Terminal sessions inside a VM. guestd owns them, so they keep running (with
// their scrollback) while no browser is attached.

// The command each agent CLI is started with.
export const Agents = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  agy: 'agy',
} as const
export const Agent = z.enum(['claude', 'codex', 'opencode', 'agy'])
export type Agent = z.infer<typeof Agent>

export const CreateSession = z.object({
  // Start an agent instead of a plain shell. A shell takes over when it exits.
  agent: Agent.optional(),
  mode: AgentMode.optional(),
  // Set by hostd after it has created the pre-run disk checkpoint.
  checkpointId: z.string().uuid().optional(),
})
export type CreateSession = z.infer<typeof CreateSession>

export const Session = z.object({
  id: z.string(),
  agent: Agent.nullable(),
  createdAt: z.string(),
  state: z.enum(['running', 'exited']),
  exitCode: z.number().int().nullable(),
  mode: AgentMode.optional(),
  checkpointId: z.string().uuid().nullable().optional(),
})
export type Session = z.infer<typeof Session>

const Cols = z.number().int().min(2).max(500)
const Rows = z.number().int().min(1).max(200)

// Browser → guestd, as JSON text frames.
export const TerminalInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(65_536) }),
  z.object({ type: z.literal('resize'), cols: Cols, rows: Rows }),
])
export type TerminalInput = z.infer<typeof TerminalInput>

// guestd → browser. Every attach starts with `ready`, carrying the scrollback.
export const TerminalOutput = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    scrollback: z.string(),
    truncated: z.boolean(),
    cols: Cols,
    rows: Rows,
    state: z.enum(['running', 'exited']),
    exitCode: z.number().int().nullable(),
  }),
  z.object({ type: z.literal('output'), data: z.string() }),
  z.object({ type: z.literal('exit'), exitCode: z.number().int() }),
])
export type TerminalOutput = z.infer<typeof TerminalOutput>
