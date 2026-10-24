import type { Agent } from '@substrate/protocol'

// The coding agents every Linux workspace comes with (images/guest).
export const agentCatalog: { id: Agent; name: string; maker: string; blurb: string }[] = [
  { id: 'claude', name: 'Claude Code', maker: 'Anthropic', blurb: 'Agentic coding in your terminal: reads the codebase, edits files, runs commands.' },
  { id: 'codex', name: 'Codex', maker: 'OpenAI', blurb: 'OpenAI’s coding agent CLI, sandboxed to the workspace.' },
  { id: 'opencode', name: 'OpenCode', maker: 'SST', blurb: 'An open-source terminal agent that works with many model providers.' },
  { id: 'agy', name: 'Antigravity', maker: 'Google', blurb: 'Google’s agent CLI, for planning and carrying out multi-step changes.' },
]

export const agentName = (agent: Agent | null | undefined) => (agent ? agentCatalog.find((a) => a.id === agent)?.name ?? agent : 'Shell')
