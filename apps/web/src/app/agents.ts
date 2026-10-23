import type { Agent } from '@substrate/protocol'

// The coding agents every Linux workspace comes with (images/guest).
export const agentCatalog: { id: Agent; name: string; maker: string; blurb: string; monogram: string }[] = [
  { id: 'claude', name: 'Claude Code', maker: 'Anthropic', monogram: 'C', blurb: 'Agentic coding in your terminal: reads the codebase, edits files, runs commands.' },
  { id: 'codex', name: 'Codex', maker: 'OpenAI', monogram: 'X', blurb: 'OpenAI’s coding agent CLI, sandboxed to the workspace.' },
  { id: 'opencode', name: 'OpenCode', maker: 'SST', monogram: 'O', blurb: 'An open-source terminal agent that works with many model providers.' },
  { id: 'agy', name: 'Antigravity', maker: 'Google', monogram: 'A', blurb: 'Google’s agent CLI, for planning and carrying out multi-step changes.' },
]

export const agentName = (agent: Agent | null | undefined) => (agent ? agentCatalog.find((a) => a.id === agent)?.name ?? agent : 'Shell')
