import { $ } from 'bun'
import { stat } from 'node:fs/promises'
import { sh } from './sh.ts'

export async function datasetExists(name: string) {
  return (await $`zfs list -H -o name ${name}`.quiet().nothrow()).exitCode === 0
}

export async function createFilesystem(name: string) {
  await sh`zfs create ${name}`
}

// A copy-on-write clone of the image's root disk, grown to the VM's disk size.
export async function cloneVolume(snapshot: string, name: string, sizeGib: number) {
  await sh`zfs clone ${snapshot} ${name}`
  await sh`zfs set volsize=${sizeGib}G ${name}`
}

// Grows the ext4 filesystem to fill its (bigger) volume, before the VM first
// boots. The guest can't do it itself: Firecracker's kernel config refuses
// writes to a mounted disk (BLK_DEV_WRITE_MOUNTED), which online resize needs.
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
