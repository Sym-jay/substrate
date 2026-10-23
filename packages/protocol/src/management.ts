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

export const PublicKey = z.string().trim().max(16_384).regex(/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,3}(?: [^\r\n]*)?$/, 'Use an OpenSSH public key')
export const SshKey = z.object({ publicKey: PublicKey })

// The keys from the owner's account that a VM should trust (hostd keeps them
// in their own block of dev's authorized_keys). With `start`, a stopped or
// paused VM is started first.
export const SyncSshKeys = z.object({ publicKeys: PublicKey.array().max(20), start: z.boolean().optional() })
export type SyncSshKeys = z.infer<typeof SyncSshKeys>

// SSH keys saved on a user's account, trusted by all their VMs.
export const AccountSshKey = z.object({ id: z.string(), name: z.string(), fingerprint: z.string(), publicKey: z.string(), createdAt: z.string() })
export type AccountSshKey = z.infer<typeof AccountSshKey>
export const AddAccountSshKey = z.object({ name: z.string().trim().max(64).optional(), publicKey: PublicKey })
export type AddAccountSshKey = z.infer<typeof AddAccountSshKey>

// Personal tokens that let an SSH client (ssh-proxy.mjs) reach the user's
// VMs through the control box. Shown once; only a hash is kept.
export const SshToken = z.object({ id: z.string(), name: z.string(), createdAt: z.string(), lastUsedAt: z.string().nullable() })
export type SshToken = z.infer<typeof SshToken>
export const CreateSshToken = z.object({ name: z.string().trim().min(1).max(64) })

// A VM's desktop for the web app: ready when something answers VNC (port
// 5900) on it; off, setting-up or failed otherwise; unavailable when the VM
// isn't running.
export const VmGuiState = z.enum(['ready', 'off', 'setting-up', 'failed', 'unavailable'])
export type VmGuiState = z.infer<typeof VmGuiState>
export const VmGui = z.object({ state: VmGuiState, available: z.boolean() })
export type VmGui = z.infer<typeof VmGui>
