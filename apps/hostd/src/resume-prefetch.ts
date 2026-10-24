import { open, readFile, stat, writeFile } from 'node:fs/promises'
import { $ } from 'bun'
import { unitName } from './firecracker.ts'

const PAGE = 4096, MAX_BYTES = 64 * 1024 * 1024, MAX_RANGES = 4096
type Range = { offset: number; length: number }
type Hint = { version: 1; fileSize: number; ranges: Range[] }

export function validHint(value: unknown, size: number): value is Hint {
  const hint = value as Hint | null
  if (!hint || hint.version !== 1 || hint.fileSize !== size || !Array.isArray(hint.ranges) || hint.ranges.length > MAX_RANGES) return false
  let end = 0, total = 0
  for (const row of hint.ranges) {
    if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.offset) || !Number.isSafeInteger(row.length) || row.offset < end || row.length <= 0 ||
      row.offset % PAGE || row.length % PAGE || row.offset + row.length > size) return false
    end = row.offset + row.length; total += row.length
    if (total > MAX_BYTES) return false
  }
  return true
}

// Observe only resident-page metadata in this VM's previous immutable memory
// mapping, after its CPUs are paused and before snapshot creation touches it.
// Never read guest memory or clear its accessed/dirty bits. An absent hint is
// normal for the first pause, unsupported kernels and large working sets.
export async function captureWorkingSet(vmId: string, memory: string): Promise<Hint | null> {
  if (process.platform !== 'linux' || process.arch !== 'x64') return null
  try {
    const pid = (await $`systemctl show -p MainPID --value ${unitName(vmId)}`.quiet().text()).trim()
    if (!/^[1-9][0-9]*$/.test(pid)) return null
    const size = (await stat(memory)).size
    const mappings = (await readFile(`/proc/${pid}/maps`, 'utf8')).split('\n').flatMap((line) => {
      const fields = line.trim().split(/\s+/)
      if (fields.slice(5).join(' ') !== memory) return []
      const [start, end] = fields[0]!.split('-').map(n => Number.parseInt(n, 16))
      return [{ start: start!, end: end!, offset: Number.parseInt(fields[2]!, 16) }]
    })
    const pages = await open(`/proc/${pid}/pagemap`, 'r'), ranges: Range[] = []
    let bytes = 0
    try {
      for (const map of mappings.sort((a, b) => a.offset - b.offset)) {
        for (let address = map.start; address < map.end;) {
          const count = Math.min(8192, (map.end - address) / PAGE), buffer = Buffer.alloc(count * 8)
          const { bytesRead } = await pages.read(buffer, 0, buffer.length, address / PAGE * 8)
          if (bytesRead !== buffer.length) return null
          for (let i = 0; i < count; i++) {
            if (!(buffer.readUInt32LE(i * 8 + 4) & 0x80000000)) continue
            const offset = map.offset + address - map.start + i * PAGE
            const last = ranges.at(-1)
            if (last && last.offset + last.length === offset) last.length += PAGE
            else ranges.push({ offset, length: PAGE })
            bytes += PAGE
            if (bytes > MAX_BYTES || ranges.length > MAX_RANGES) return null
          }
          address += count * PAGE
        }
      }
    } finally { await pages.close() }
    const hint: Hint = { version: 1, fileSize: size, ranges }
    return ranges.length && validHint(hint, size) ? hint : null
  } catch { return null }
}

export async function saveWorkingSet(path: string, hint: Hint | null) {
  if (hint) await writeFile(path, JSON.stringify(hint), { mode: 0o600 }).catch(() => {})
}

// Read at most 64 MiB with four bounded buffers and a scheduling budget. Reads
// populate the host page cache; the immutable memory file is never modified.
// All in-flight reads finish before returning, even after an I/O error.
export async function prefetchWorkingSet(memory: string, path: string) {
  try {
    if ((await stat(path)).size > 256 * 1024) return 0
    const hint: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!validHint(hint, (await stat(memory)).size)) return 0
    const file = await open(memory, 'r'), deadline = performance.now() + 120
    let cursor = 0, bytes = 0
    const worker = async () => {
      const buffer = Buffer.alloc(1024 * 1024)
      for (;;) {
        const range = hint.ranges[cursor++]
        if (!range || performance.now() >= deadline) return
        for (let position = range.offset; position < range.offset + range.length && performance.now() < deadline;) {
          const length = Math.min(buffer.length, range.offset + range.length - position)
          const { bytesRead } = await file.read(buffer, 0, length, position)
          if (!bytesRead) return
          position += bytesRead; bytes += bytesRead
        }
      }
    }
    try { await Promise.allSettled(Array.from({ length: 4 }, worker)) }
    finally { await file.close() }
    return bytes
  } catch { return 0 }
}
