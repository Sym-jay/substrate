import { z } from 'zod'

// Preset sizes. `large` is the default: enough for Claude Code plus a build.
export const VmSizes = {
  large: { vcpus: 6, memMib: 16_384 },
  medium: { vcpus: 4, memMib: 8_192 },
  small: { vcpus: 2, memMib: 4_096 },
} as const
export const VmSizeName = z.enum(['large', 'medium', 'small'])
export type VmSizeName = z.infer<typeof VmSizeName>
export const DEFAULT_VM_SIZE: VmSizeName = 'large'

export const VmState = z.enum(['starting', 'running', 'stopping', 'stopped', 'failed'])
export type VmState = z.infer<typeof VmState>

export const Vm = z.object({
  id: z.string(),
  name: z.string(),
  vcpus: z.number().int(),
  memMib: z.number().int(),
  diskGib: z.number().int(),
  state: VmState,
  // The image version the VM's disk was cloned from.
  image: z.string(),
  guestIp: z.string(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  // From launching Firecracker to the guest agent answering, on the last boot.
  bootMs: z.number().nullable(),
  lastError: z.string().nullable(),
})
export type Vm = z.infer<typeof Vm>

export const VmName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/, 'lowercase letters, digits and dashes')

// VM disks are thin: a disk only takes up the space the VM actually writes.
export const DEFAULT_DISK_GIB = 32

export const CreateVm = z.object({
  name: VmName.optional(),
  size: VmSizeName.optional(),
  // hostd also holds this between the image's own size and the host's storage pool.
  diskGib: z.number().int().min(8).max(1024).optional(),
})
export type CreateVm = z.infer<typeof CreateVm>

export const ExecRequest = z.object({
  command: z.string().min(1),
  // Agents run as `dev`; `root` is for admin work.
  user: z.enum(['dev', 'root']).default('dev'),
  timeoutMs: z.number().int().min(100).max(600_000).default(60_000),
})
export type ExecRequest = z.infer<typeof ExecRequest>
export type ExecRequestInput = z.input<typeof ExecRequest>

export const ExecResult = z.object({
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number(),
  timedOut: z.boolean(),
})
export type ExecResult = z.infer<typeof ExecResult>

export const GuestHealth = z.object({
  ok: z.literal(true),
  vmId: z.string(),
  version: z.string(),
  uptimeMs: z.number(),
})
export type GuestHealth = z.infer<typeof GuestHealth>

export const HostdHealth = z.object({
  ok: z.literal(true),
  version: z.string(),
  // The image new VMs get, or null before the first `bun run images:build`.
  image: z.string().nullable(),
})
export type HostdHealth = z.infer<typeof HostdHealth>

export const Capacity = z.object({
  vcpus: z.number().int(),
  memTotalMib: z.number().int(),
  memReservedMib: z.number().int(),
  memUsedMib: z.number().int(),
  memFreeMib: z.number().int(),
})
export type Capacity = z.infer<typeof Capacity>

export const ApiError = z.object({ error: z.string() })
export type ApiError = z.infer<typeof ApiError>

// The guest agent listens on this port on the VM's private link.
export const GUESTD_PORT = 7000
