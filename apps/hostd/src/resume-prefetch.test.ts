import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prefetchWorkingSet, validHint } from './resume-prefetch.ts'

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
