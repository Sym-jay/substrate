import { DEFAULT_DISK_GIB, DEFAULT_VM_SIZE, VmLimits, VmSizeName, VmSizes, type CreateVm, type WarmPoolSize } from '@substrate/protocol'
import { message } from './errors.ts'

// A size of VM to keep booted ahead of time, and how many of it.
export type PoolSpec = { vcpus: number; memMib: number; diskGib: number; count: number }

// SUBSTRATE_WARM_POOL: comma-separated `<size>[@<diskGib>]:<count>`, where a
// size is a preset (`large`) or `<vcpus>x<memGib>` (`2x2`). For example
// `large:1,2x2:8`. Unset: one of the default size, with the launcher's default
// disk. `off` (or `0`) keeps none.
export function parsePoolSpecs(text: string | undefined): PoolSpec[] {
  const value = text?.trim()
  if (!value) return [{ ...VmSizes[DEFAULT_VM_SIZE], diskGib: DEFAULT_DISK_GIB, count: 1 }]
  if (value === 'off' || value === '0') return []
  return value.split(',').map((part) => {
    const match = /^\s*([a-z]+|\d+x\d+)(?:@(\d+))?:(\d+)\s*$/.exec(part)
    if (!match) throw new Error(`SUBSTRATE_WARM_POOL: can't read "${part}"; write <size>[@<diskGib>]:<count>, e.g. large:1,2x2:8`)
    const [, size, disk, count] = match as unknown as [string, string, string | undefined, string]
    const preset = VmSizeName.safeParse(size)
    if (!preset.success && !/^\d+x\d+$/.test(size)) throw new Error(`SUBSTRATE_WARM_POOL: "${size}" isn't a preset (large, medium, small) or <vcpus>x<memGib>`)
    const [vcpus, memGib] = preset.success
      ? [VmSizes[preset.data].vcpus, VmSizes[preset.data].memMib / 1024]
      : size.split('x').map(Number) as [number, number]
    const spec = { vcpus, memMib: memGib * 1024, diskGib: disk ? Number(disk) : DEFAULT_DISK_GIB, count: Number(count) }
    if (spec.vcpus < VmLimits.vcpus.min || spec.vcpus > VmLimits.vcpus.max || spec.memMib < VmLimits.memMib.min || spec.memMib > VmLimits.memMib.max || spec.diskGib < 8) {
      throw new Error(`SUBSTRATE_WARM_POOL: "${part}" is outside the sizes a VM can have`)
    }
    return spec
  }).filter((spec) => spec.count > 0)
}

// The size a create asks for, its preset's where it doesn't say.
export function requestedSize(input: CreateVm) {
  const preset = VmSizes[input.size ?? DEFAULT_VM_SIZE]
  return { vcpus: input.vcpus ?? preset.vcpus, memMib: input.memMib ?? preset.memMib, diskGib: input.diskGib ?? DEFAULT_DISK_GIB }
}

// Whether a pooled VM can be handed to a create: the same vCPUs and memory,
// which are fixed once it has booted; a disk no bigger than asked for, since
// disks grow but don't shrink; and open egress, since an allowlist is set up
// when a VM boots.
export function fits(vm: { vcpus: number; memMib: number; diskGib: number }, input: CreateVm) {
  const want = requestedSize(input)
  return vm.vcpus === want.vcpus && vm.memMib === want.memMib && vm.diskGib <= want.diskGib && (input.egress?.mode ?? 'open') === 'open'
}

// A VM in the pool: booted and waiting, still booting, or one that went down
// (or failed to boot) and needs replacing.
export type Pooled = { id: string; vcpus: number; memMib: number; diskGib: number; image: string; state: 'ready' | 'booting' | 'dead' }

// What the pool needs from hostd. VmManager provides it; tests substitute a fake.
export interface PoolHost {
  pooled(): Promise<Pooled[]>
  // The current image's version, or null before there is one.
  image(): Promise<string | null>
  memFreeMib(): Promise<number>
  // Boots one VM of this size into the pool; resolves once it's ready.
  boot(spec: PoolSpec): Promise<void>
  discard(id: string): Promise<void>
}

const sameSize = (spec: PoolSpec, vm: Pooled) => vm.vcpus === spec.vcpus && vm.memMib === spec.memMib && vm.diskGib === spec.diskGib

// Keeps each size topped up. VMs from an older image, of a size no longer
// wanted, or that went down are replaced. Boots run side by side, but never
// into the last of the host's memory: a cold create of the same size must
// still fit after the pool's.
export class WarmPool {
  private filling: Promise<void> | null = null
  private retryAt = 0

  constructor(
    private readonly host: PoolHost,
    readonly specs: PoolSpec[],
    private readonly log: (line: string) => void = console.error,
    private readonly now = Date.now,
  ) {}

  // One fill at a time; a fill asked for during one joins it.
  fill(): Promise<void> {
    this.filling ??= this.fillOnce().finally(() => { this.filling = null })
    return this.filling
  }

  start(intervalMs: number) {
    const tick = () => void this.fill()
    tick()
    return setInterval(tick, intervalMs)
  }

  async status(): Promise<WarmPoolSize[]> {
    const [image, pooled] = await Promise.all([this.host.image(), this.host.pooled()])
    return this.specs.map((spec) => {
      const mine = pooled.filter((vm) => sameSize(spec, vm) && vm.image === image)
      return { vcpus: spec.vcpus, memMib: spec.memMib, diskGib: spec.diskGib, want: spec.count,
        ready: mine.filter((vm) => vm.state === 'ready').length, booting: mine.filter((vm) => vm.state === 'booting').length }
    })
  }

  private async fillOnce() {
    if (this.now() < this.retryAt) return
    try {
      const image = await this.host.image()
      const pooled = await this.host.pooled()
      const stale = pooled.filter((vm) => vm.state === 'dead' || (image !== null && vm.image !== image) || !this.specs.some((spec) => sameSize(spec, vm)))
      for (const vm of stale) await this.host.discard(vm.id)
      if (image === null) return
      let free = await this.host.memFreeMib()
      const boots: Promise<void>[] = []
      for (const spec of this.specs) {
        const have = pooled.filter((vm) => !stale.includes(vm) && sameSize(spec, vm)).length
        for (let i = have; i < spec.count && free - spec.memMib >= spec.memMib; i++) {
          free -= spec.memMib
          boots.push(this.host.boot(spec))
        }
      }
      const failed = (await Promise.allSettled(boots)).filter((result) => result.status === 'rejected')
      if (failed.length) throw (failed[0] as PromiseRejectedResult).reason
    } catch (error) {
      // A boot that failed is likely to fail again straight away: wait a while.
      this.retryAt = this.now() + 60_000
      this.log(`warm pool: ${message(error)}`)
    }
  }
}
