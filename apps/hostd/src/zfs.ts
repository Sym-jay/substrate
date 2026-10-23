import type { PoolStatus } from '@substrate/protocol'
import { $ } from 'bun'
import { stat } from 'node:fs/promises'
import { sh } from './sh.ts'

export async function datasetExists(name: string) {
  return (await $`zfs list -H -o name ${name}`.quiet().nothrow()).exitCode === 0
}

export async function createFilesystem(name: string) {
  await sh`zfs create ${name}`
}

export async function snapshot(name: string) {
  await sh`zfs snapshot ${name}`
}

// Called only with Firecracker down. A retry must restore the disk paired
// with the saved memory, including after an unsuccessful resume.
export async function rollback(name: string) {
  await sh`zfs rollback -r ${name}`
}

export async function syncPool(pool: string) {
  await sh`zpool sync ${pool}`
}

// A copy-on-write clone of the image's root disk, grown to the VM's disk size.
export async function cloneVolume(snapshot: string, name: string, sizeGib: number) {
  await sh`zfs clone ${snapshot} ${name}`
  await sh`zfs set volsize=${sizeGib}G ${name}`
}

// Full compressed sends give a fork independent ownership of its blocks:
// deleting either VM never needs to delete snapshots belonging to the other.
export async function copySnapshot(snapshot: string, destination: string, filesystem = false) {
  if (filesystem) {
    await sh`zfs send -c ${snapshot} | zfs receive -u -x mountpoint ${destination}`
    await sh`zfs mount ${destination}`
  } else {
    await sh`zfs send -c ${snapshot} | zfs receive -u ${destination}`
  }
}

export async function setVolumeSize(name: string, sizeGib: number) {
  await sh`zfs set volsize=${sizeGib}G ${name}`
}

// Grows the ext4 filesystem to fill its (bigger) volume while the VM is
// stopped. resize2fs can't do it inside a running guest: Firecracker's kernel
// config refuses writes to a mounted disk (BLK_DEV_WRITE_MOUNTED). A running
// guest uses the resize ioctl instead (see growDisk in vms.ts).
export async function growFilesystem(device: string) {
  // e2fsck exits 1 when it fixed something, which is fine here.
  const check = await $`e2fsck -fp ${device}`.quiet().nothrow()
  if (check.exitCode > 1) throw new Error(`e2fsck failed (${check.exitCode}): ${check.stderr.toString().trim()}`)
  await sh`resize2fs ${device}`
}

// Retries because a zvol stays busy for a moment after Firecracker exits.
export async function destroy(name: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await sh`zfs destroy -r ${name}`
    } catch (err) {
      if (attempt === 10) throw err
      await Bun.sleep(300)
    }
  }
}

const GIB = 2 ** 30

export async function volumeSizeGib(name: string) {
  return Number((await sh`zfs get -Hp -o value volsize ${name}`).trim()) / GIB
}

export async function poolSizeGib(pool: string) {
  return Math.floor(Number((await sh`zpool list -Hp -o size ${pool}`).trim()) / GIB)
}

export async function poolStatus(pool: string): Promise<PoolStatus> {
  const [health = '', size = '0', capacity = '0'] = (await sh`zpool list -Hp -o health,size,capacity ${pool}`).trim().split('\t')
  return { health, sizeGib: Math.floor(Number(size) / GIB), usedPct: Number(capacity) }
}

export function zvolDevice(name: string) {
  return `/dev/zvol/${name}`
}

// udev creates a zvol's device node a moment after `zfs clone` returns.
// (Bun.file().exists() is false for block devices, hence stat.)
export async function waitForDevice(path: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await stat(path).then((s) => s.isBlockDevice(), () => false))) {
    if (Date.now() > deadline) throw new Error(`${path} never appeared`)
    await Bun.sleep(50)
  }
}
