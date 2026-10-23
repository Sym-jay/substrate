import { z } from 'zod'
import { GitHubRepo } from './github.ts'
import { EgressPolicy } from './egress.ts'

// Preset sizes. `large` is the default: enough for Claude Code plus a build.
export const VmSizes = {
  large: { vcpus: 6, memMib: 16_384 },
  medium: { vcpus: 4, memMib: 8_192 },
  small: { vcpus: 2, memMib: 4_096 },
} as const
export const VmSizeName = z.enum(['large', 'medium', 'small'])
export type VmSizeName = z.infer<typeof VmSizeName>
export const DEFAULT_VM_SIZE: VmSizeName = 'large'

export const VmState = z.enum(['starting', 'running', 'stopping', 'stopped', 'failed', 'pausing', 'paused', 'resuming', 'forking', 'checkpointing', 'resizing'])
export type VmState = z.infer<typeof VmState>

export const VmMemory = z.object({
  floorMib: z.number().int().positive(),
  limitMib: z.number().int().positive(),
  targetMib: z.number().int().nonnegative().nullable(),
  actualMib: z.number().int().nonnegative().nullable(),
  availableMib: z.number().nonnegative().nullable(),
  residentMib: z.number().nonnegative().nullable(),
  proportionalMib: z.number().nonnegative().nullable(),
  sampledAt: z.string().nullable(),
})
export type VmMemory = z.infer<typeof VmMemory>

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
  // Optional so an M3 client can still read an older hostd.
  pausedAt: z.string().nullable().optional(),
  pauseMs: z.number().nullable().optional(),
  resumeMs: z.number().nullable().optional(),
  // When the VM last booted or resumed.
  awakeSince: z.string().nullable().optional(),
  // Pause the VM after this many idle minutes; null never does. Optional so
  // the client can still read a hostd from before M4.
  autoPauseMinutes: z.number().int().nullable().optional(),
  repository: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  // Pause the VM once it has been awake this long, even if busy, so a stuck
  // agent can't run forever; null never does. Optional for a pre-M7 hostd.
  maxAwakeHours: z.number().int().nullable().optional(),
  // memMib remains the ceiling; this reports the live, elastic allocation.
  memory: VmMemory.nullable().optional(),
  // Phase 2: whether it runs under the jailer, and where it may connect out to.
  isolation: z.enum(['none', 'jail']).optional(),
  egress: EgressPolicy.optional(),
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
  repository: GitHubRepo.optional(),
  egress: EgressPolicy.optional(),
})
export type CreateVm = z.infer<typeof CreateVm>

// A new VM pauses after this many idle minutes.
export const DEFAULT_AUTO_PAUSE_MINUTES = 10
export const AutoPauseMinutes = z.number().int().min(1).max(1440).nullable()

export const DEFAULT_MAX_AWAKE_HOURS = 24
export const MaxAwakeHours = z.number().int().min(1).max(720).nullable()

// A new egress policy takes effect at the VM's next start.
export const UpdateVm = z
  .object({ autoPauseMinutes: AutoPauseMinutes.optional(), maxAwakeHours: MaxAwakeHours.optional(), egress: EgressPolicy.optional() })
  .refine((v) => v.autoPauseMinutes !== undefined || v.maxAwakeHours !== undefined || v.egress !== undefined, 'nothing to change')
export type UpdateVm = z.infer<typeof UpdateVm>

// Disks only grow: shrinking one could cut off data the guest wrote.
export const GrowDisk = z.object({ diskGib: z.number().int().min(8).max(1024) })
export type GrowDisk = z.infer<typeof GrowDisk>

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
  features: z.object({ forkNetwork: z.boolean() }).optional(),
})
export type GuestHealth = z.infer<typeof GuestHealth>

export const PoolStatus = z.object({
  // ZFS's word for it: ONLINE when all is well, DEGRADED, FAULTED, ...
  health: z.string(),
  sizeGib: z.number(),
  usedPct: z.number(),
})
export type PoolStatus = z.infer<typeof PoolStatus>

export const HostdHealth = z.object({
  ok: z.literal(true),
  version: z.string(),
  // The image new VMs get, or null before the first `bun run images:build`.
  image: z.string().nullable(),
  // The storage pool every VM's disk and saved memory share. Optional for a pre-M7 hostd.
  pool: PoolStatus.nullable().optional(),
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

// A VM's recent logs: its console, and what hostd said about it.
export const VmLogs = z.object({ console: z.string(), host: z.string() })
export type VmLogs = z.infer<typeof VmLogs>

export const ApiError = z.object({ error: z.string() })
export type ApiError = z.infer<typeof ApiError>

// The guest agent listens on this port on the VM's private link.
export const GUESTD_PORT = 7000
