import { readdir, rename } from 'node:fs/promises'
import { z } from 'zod'
import { config } from './config.ts'

// Everything hostd knows about a VM, in vm.json inside the VM's own ZFS
// dataset. The dataset existing is what makes the VM exist.
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
})
export type VmRecord = z.infer<typeof VmRecord>

export const vmDir = (id: string) => `${config.paths.vms}/${id}`
const recordPath = (id: string) => `${vmDir(id)}/vm.json`

export async function writeRecord(record: VmRecord) {
  const path = recordPath(record.id)
  // Write then rename, so a crash never leaves half a file. 0600: it holds the guest token.
  await Bun.write(`${path}.tmp`, JSON.stringify(record, null, 2), { mode: 0o600 })
  await rename(`${path}.tmp`, path)
}

export async function readRecord(id: string): Promise<VmRecord | null> {
  const file = Bun.file(recordPath(id))
  if (!(await file.exists())) return null
  return VmRecord.parse(await file.json())
}

export async function listRecords(): Promise<VmRecord[]> {
  const ids = await readdir(config.paths.vms).catch(() => [])
  const records = await Promise.all(ids.map(readRecord))
  return records.filter((r): r is VmRecord => r !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
