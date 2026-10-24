import { z } from 'zod'
import { VmSizeName } from './vm.ts'

// A user's limits (Phase 2). The control box has defaults; an admin can set
// any user's own.
export const Quota = z.object({
  maxVms: z.number().int().min(0),
  sizes: VmSizeName.array(),
  // Per VM, and across all of a user's VMs.
  maxDiskGib: z.number().int().min(8),
  maxTotalDiskGib: z.number().int().min(8),
  // Running time across all of a user's VMs, per calendar month (UTC).
  maxRunningHours: z.number().min(0),
  // 'allowlist' makes every new VM's egress allowlisted.
  egress: z.enum(['open', 'allowlist']),
})
export type Quota = z.infer<typeof Quota>

export const QuotaStatus = z.object({
  limits: Quota,
  used: z.object({ vms: z.number().int(), totalDiskGib: z.number(), runningHours: z.number() }),
})
export type QuotaStatus = z.infer<typeof QuotaStatus>

// This month's metered use, per VM: the basis for billing.
export const UsageReport = z.object({
  month: z.string(),
  vms: z.object({ vmId: z.string(), runningHours: z.number(), vcpuHours: z.number(), gibHours: z.number() }).array(),
  totals: z.object({ runningHours: z.number(), vcpuHours: z.number(), gibHours: z.number() }),
})
export type UsageReport = z.infer<typeof UsageReport>

export const AccountEvent = z.object({
  id: z.string(),
  vmId: z.string().nullable(),
  kind: z.string(),
  detail: z.record(z.string(), z.unknown()).nullable(),
  at: z.string(),
})
export type AccountEvent = z.infer<typeof AccountEvent>

export const GitHubStatus = z.object({
  connected: z.boolean(),
  login: z.string().nullable(),
  // Whether "Connect with GitHub" (OAuth) is set up; a token can always be pasted.
  oauth: z.boolean(),
})
export type GitHubStatus = z.infer<typeof GitHubStatus>

export const GitHubRepoInfo = z.object({
  fullName: z.string(),
  private: z.boolean(),
  description: z.string().nullable(),
  defaultBranch: z.string(),
  pushedAt: z.string().nullable(),
})
export type GitHubRepoInfo = z.infer<typeof GitHubRepoInfo>

export const SetGitHubToken = z.object({ token: z.string().trim().min(20).max(400).regex(/^[A-Za-z0-9_]+$/, "that doesn't look like a GitHub token") })
export type SetGitHubToken = z.infer<typeof SetGitHubToken>
