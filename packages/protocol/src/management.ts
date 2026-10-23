import { z } from 'zod'
import { Agent } from './terminal.ts'
import { AgentMode } from './github.ts'
import { VmName, VmSizeName } from './vm.ts'

export const ResizeVm = z.object({
  size: VmSizeName.optional(),
  diskGib: z.number().int().min(8).max(1024).optional(),
}).refine((value) => value.size !== undefined || value.diskGib !== undefined, 'Choose a size or disk capacity')
export type ResizeVm = z.infer<typeof ResizeVm>
export const ForkVm = z.object({ name: VmName.optional() })
export type ForkVm = z.infer<typeof ForkVm>

export const RunCheckpoint = z.object({
  id: z.string().uuid(),
  createdAt: z.string(),
  label: z.string(),
  agent: Agent.nullable(),
  mode: AgentMode.nullable(),
  sessionId: z.string().nullable(),
})
export type RunCheckpoint = z.infer<typeof RunCheckpoint>

export const SshKey = z.object({
  publicKey: z.string().trim().max(16_384).regex(/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,3}(?: [^\r\n]*)?$/, 'Use an OpenSSH public key'),
})
