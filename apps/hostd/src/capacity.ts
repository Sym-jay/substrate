import type { Capacity } from '@substrate/protocol'
import { cpus } from 'node:os'

export function parseMemTotalMib(meminfo: string): number {
  const kib = Number(/^MemTotal:\s+(\d+) kB$/m.exec(meminfo)?.[1])
  if (!kib) throw new Error("couldn't read MemTotal")
  return Math.floor(kib / 1024)
}

// Memory is never overcommitted: a VM can touch all of its RAM. CPU is
// overcommitted freely, since agents mostly wait on model APIs.
export function computeCapacity(opts: {
  memTotalMib: number
  memReservedMib: number
  memUsedMib: number
  vcpus: number
}): Capacity {
  return {
    ...opts,
    memFreeMib: Math.max(0, opts.memTotalMib - opts.memReservedMib - opts.memUsedMib),
  }
}

export async function hostCapacity(memUsedMib: number, memReservedMib: number): Promise<Capacity> {
  const memTotalMib = parseMemTotalMib(await Bun.file('/proc/meminfo').text())
  return computeCapacity({ memTotalMib, memReservedMib, memUsedMib, vcpus: cpus().length })
}
