// Times creating VMs from the warm pool on the real host: each claim, and a
// first terminal command in it. Only VMs it claims are touched, and deleted
// again. The host must be running with a pool of this size.
//   bun run benchmark:warm-pool [--size large|<vcpus>x<memGib>] [--disk 32] [--count 5] [--parallel]
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { VmSizeName, VmSizes } from '@substrate/protocol'
import { instanceState, run, stackOutputs } from './lib/aws.ts'

const option = (name: string, fallback: string) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback
const sizeName = option('--size', 'large'), diskGib = Number(option('--disk', '32')), count = Number(option('--count', '5'))
const parallel = process.argv.includes('--parallel')
const preset = VmSizeName.safeParse(sizeName)
const [vcpus, memGib] = preset.success ? [VmSizes[preset.data].vcpus, VmSizes[preset.data].memMib / 1024] : sizeName.split('x').map(Number) as [number, number]
if (!vcpus || !memGib || !Number.isInteger(count) || count < 1 || count > 32 || !Number.isInteger(diskGib)) throw new Error('invalid options')

const out = await stackOutputs(), host = out.HostInstanceId, marker = randomUUID().slice(0, 8)
if (await instanceState(host) !== 'running') throw new Error('host must already be running')
const source = Buffer.from(await Bun.file(new URL('./lib/warm-pool-probe.ts', import.meta.url)).text()).toString('base64')
const args = Buffer.from(JSON.stringify({ vcpus, memMib: memGib * 1024, diskGib, count, parallel, marker })).toString('base64')
const remote = `/tmp/substrate-warm-${marker}.ts`
const response = await run(host, ['set -e', `trap 'unlink ${remote}' EXIT`, `printf %s '${source}' | base64 -d > '${remote}'`,
  'export PATH="$PATH:/usr/local/bin"', `bun '${remote}' '${args}'`].join('\n'), 900)
if (!response.ok) throw new Error(response.stderr || response.stdout || 'warm pool probe failed')
const result = JSON.parse(response.stdout) as { samples: { claimMs: number; hit: boolean; terminalMs?: number; named?: boolean }[]; profiles: unknown[] }
await mkdir('.data', { recursive: true })
await writeFile(`.data/warm-pool-${marker}.json`, JSON.stringify({ vcpus, memGib, diskGib, count, parallel, ...result }, null, 2), { mode: 0o600 })

const ms = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? `median ${Math.round(sorted[Math.floor(sorted.length / 2)]!)} ms, max ${Math.round(sorted.at(-1)!)} ms` : '—'
}
const hits = result.samples.filter((s) => s.hit)
console.log(`${parallel ? 'parallel' : 'one at a time'}: ${hits.length} of ${count} claimed from the pool (${vcpus} vCPU, ${memGib} GiB, ${diskGib} GiB disk)`)
console.log(`  claim (VM ready):        ${ms(hits.map((s) => s.claimMs))}`)
console.log(`  first terminal command:  ${ms(hits.flatMap((s) => s.terminalMs ?? []))}`)
console.log(`  hostname already set:    ${hits.filter((s) => s.named).length} of ${hits.length}`)
console.log(`results: .data/warm-pool-${marker}.json`)
