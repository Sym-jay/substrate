import { open, readdir, rename } from 'node:fs/promises'
import { AutoPauseMinutes, DEFAULT_AUTO_PAUSE_MINUTES, DEFAULT_MAX_AWAKE_HOURS, EgressPolicy, MaxAwakeHours } from '@substrate/protocol'
import { z } from 'zod'
import { RunCheckpoint } from '@substrate/protocol'
import { config } from './config.ts'

// Everything hostd knows about a VM, in vm.json inside the VM's own ZFS
// dataset. The dataset existing is what makes the VM exist.
export const Checkpoint = z.object({
  id: z.string().uuid(),
  createdAt: z.string(),
  firecrackerVersion: z.string(),
})
export type Checkpoint = z.infer<typeof Checkpoint>

export const VmRecord = z.object({
  id: z.string(),
  name: z.string(),
  vcpus: z.number().int(),
  memMib: z.number().int(),
  diskGib: z.number().int(),
  slot: z.number().int(),
  token: z.string(),
  image: z.string(),
  kernel: z.string(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  bootMs: z.number().nullable(),
  lastError: z.string().nullable(),
  checkpoint: Checkpoint.nullable().default(null),
  paused: z.boolean().default(false),
  pauseMs: z.number().nullable().default(null),
  resumeMs: z.number().nullable().default(null),
  // When it last booted or resumed, so auto-pause gives it a full idle period.
  awakeSince: z.string().nullable().default(null),
  autoPauseMinutes: AutoPauseMinutes.default(DEFAULT_AUTO_PAUSE_MINUTES),
  runCheckpoints: RunCheckpoint.array().default([]),
  repository: z.string().nullable().default(null),
  parentId: z.string().nullable().default(null),
  // New images use a stable path inside each VMM's private mount namespace.
  rootPath: z.string().nullable().default(null),
  forkCapable: z.boolean().default(false),
  // Old running VMs/snapshots have no device; enable it on their next cold boot.
  balloonEnabled: z.boolean().default(false),
  maxAwakeHours: MaxAwakeHours.default(DEFAULT_MAX_AWAKE_HOURS),
  // Started and not since stopped or deleted. A VM like this that isn't running
  // (and isn't paused) went down by itself, so hostd boots it again.
  shouldRun: z.boolean().default(false),
  // How it was last launched (see config.isolation): what a pause saved, a
  // resume must load the same way.
  isolation: z.enum(['none', 'jail']).default('none'),
  egress: EgressPolicy.default({ mode: 'open', allow: [] }),
})
export type VmRecord = z.infer<typeof VmRecord>

export const vmDir = (id: string) => `${config.paths.vms}/${id}`
const recordPath = (id: string) => `${vmDir(id)}/vm.json`

export async function writeRecord(record: VmRecord) {
  const path = recordPath(record.id)
  // Write then rename, so a crash never leaves half a file. 0600: it holds the guest token.
  await Bun.write(`${path}.tmp`, JSON.stringify(record, null, 2), { mode: 0o600 })
  const file = await open(`${path}.tmp`, 'r')
  try { await file.sync() } finally { await file.close() }
  await rename(`${path}.tmp`, path)
  const directory = await open(vmDir(record.id), 'r')
  try { await directory.sync() } finally { await directory.close() }
}

export async function readRecord(id: string): Promise<VmRecord | null> {
  const file = Bun.file(recordPath(id))
  if (!(await file.exists())) return null
  const record = VmRecord.parse(await file.json())
  // A copied filesystem is not published as a fork until its own record is
  // written. Ignore the parent's record during that short staging window.
  return record.id === id ? record : null
}

export async function listRecords(): Promise<VmRecord[]> {
  const ids = await readdir(config.paths.vms).catch(() => [])
  const records = await Promise.all(ids.map(readRecord))
  return records.filter((r): r is VmRecord => r !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
