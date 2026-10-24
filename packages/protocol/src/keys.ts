import { z } from 'zod'

// Users' own agent API keys (Phase 2). The control box keeps them encrypted
// with KMS and only ever sends them into that user's VMs, as environment
// variables for their sessions. The browser sets them and sees a hint, never
// the key.
export const AgentKeyName = z.enum(['anthropic', 'openai'])
export type AgentKeyName = z.infer<typeof AgentKeyName>
export const AGENT_KEY_ENV: Record<AgentKeyName, 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY'> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
}

const KeyValue = z.string().trim().min(8).max(400).regex(/^[A-Za-z0-9_\-.:]+$/, 'that doesn\'t look like an API key')
export const SetAgentKey = z.object({ value: KeyValue })
export type SetAgentKey = z.infer<typeof SetAgentKey>

export const AgentKeyInfo = z.object({
  name: AgentKeyName,
  // The last four characters, to tell keys apart.
  hint: z.string(),
  updatedAt: z.string(),
})
export type AgentKeyInfo = z.infer<typeof AgentKeyInfo>

// What a VM's sessions get: only these variables, only these characters.
export const AgentEnv = z.object({
  ANTHROPIC_API_KEY: KeyValue.optional(),
  OPENAI_API_KEY: KeyValue.optional(),
}).strict()
export type AgentEnv = z.infer<typeof AgentEnv>
