import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryMappings, prefetchWorkingSet, validHint } from './resume-prefetch.ts'

test('resident mappings match file identity across the jail, never a same-named snapshot in another dataset', () => {
  const text = `1000-3000 rw-p 00000000 00:123 456 /snapshots/generation/memory
4000-5000 rw-p 00003000 00:124 456 /snapshots/generation/memory
6000-7000 rw-p 00000000 00:123 789 /snapshots/generation/memory
8000-9000 rw-p 00004000 00:123 456 /another-path/memory`
  expect(memoryMappings(text, { dev: 0x100023n, ino: 456n })).toEqual([
    { start: 0x1000, end: 0x3000, offset: 0 }, { start: 0x8000, end: 0x9000, offset: 0x4000 },
  ])
  expect(memoryMappings('malformed', { dev: 0n, ino: 0n })).toEqual([])
})

test('memory hints reject corruption, overlaps, out-of-bounds pages and oversized reads', () => {
  const hint = { version: 1, fileSize: 16384, ranges: [{ offset: 0, length: 4096 }] }
  expect(validHint(hint, 16384)).toBe(true)
  for (const bad of [null, { ...hint, version: 2 }, { ...hint, fileSize: 1 }, { ...hint, ranges: [null] },
    { ...hint, ranges: [{ offset: -4096, length: 4096 }] }, { ...hint, ranges: [{ offset: 1, length: 4096 }] },
    { ...hint, ranges: [{ offset: 12288, length: 8192 }] }, { ...hint, ranges: [{ offset: 0, length: 8192 }, { offset: 4096, length: 4096 }] },
    { version: 1, fileSize: 128 * 1024 * 1024, ranges: [{ offset: 0, length: 128 * 1024 * 1024 }] }]) {
    expect(validHint(bad, (bad as typeof hint)?.fileSize ?? 16384)).toBe(false)
  }
})

test('prefetch reads hints without changing immutable memory, and invalid/missing hints are harmless', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'substrate-prefetch-')), memory = join(directory, 'memory'), hint = join(directory, 'hint')
  const bytes = Buffer.alloc(16384, 0x42)
  try {
    await writeFile(memory, bytes)
    expect(await prefetchWorkingSet(memory, hint)).toBe(0)
    await writeFile(hint, JSON.stringify({ version: 1, fileSize: bytes.length, ranges: [{ offset: 0, length: 4096 }, { offset: 8192, length: 4096 }] }))
    expect(await prefetchWorkingSet(memory, hint)).toBe(8192)
    expect(await readFile(memory)).toEqual(bytes)
    await writeFile(hint, '{broken')
    expect(await prefetchWorkingSet(memory, hint)).toBe(0)
    expect(await readFile(memory)).toEqual(bytes)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
