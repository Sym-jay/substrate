import { existsSync } from 'node:fs'
import { chown } from 'node:fs/promises'
import { config } from './config.ts'
import * as firecracker from './firecracker.ts'
import { createNamespace, createTap, namespaceAddresses, PROXY_PORT, proxyAddress, setProxied, slotAddresses } from './network.ts'
import { vmDir, type VmRecord } from './state.ts'
import * as zfs from './zfs.ts'

// How a VM's Firecracker runs: plain, or under the jailer in a network
// namespace of its own (record.isolation). Everything that differs between
// the two is here.

type Vmm = Pick<VmRecord, 'id' | 'slot' | 'isolation' | 'egress'>

const rootVolume = (id: string) => `${config.pool}/vms/${id}/root`
export const isJailed = (record: Pick<VmRecord, 'isolation'>) => record.isolation === 'jail'

// How the next cold boot runs: jailed, unless that's turned off or the host
// has no jailer.
export function isolationForBoot(): VmRecord['isolation'] {
  return config.isolation === 'jail' && existsSync(config.jailer) ? 'jail' : 'none'
}

// The host-side interface the VM's traffic arrives on, for the firewall.
export const hostInterface = (record: Vmm) => (isJailed(record) ? namespaceAddresses(record.slot).hostVeth : slotAddresses(record.slot).tap)
// The TAP Firecracker opens.
export const tapName = (record: Vmm) => (isJailed(record) ? namespaceAddresses(record.slot).tap : slotAddresses(record.slot).tap)

export function proxyUrl(record: Vmm) {
  return record.egress.mode === 'allowlist' ? `http://${proxyAddress(record.slot, isJailed(record))}:${PROXY_PORT}` : null
}

// The disk, as Firecracker sees it.
export function rootDrivePath(record: Vmm & Pick<VmRecord, 'rootPath'>) {
  return isJailed(record) ? firecracker.IN_JAIL.rootfs : record.rootPath ?? zfs.zvolDevice(rootVolume(record.id))
}

// What the guest reads from MMDS.
export function metadata(record: Vmm & Pick<VmRecord, 'name' | 'token'>, resumeSessions = false) {
  const net = slotAddresses(record.slot)
  return {
    substrate: { vmId: record.id, name: record.name, token: record.token, guestIp: net.guestIp, hostIp: net.hostIp, resumeSessions, proxy: proxyUrl(record) },
  }
}

// A jailed Firecracker writes saves as the VM's uid.
export async function ownSnapshotDir(record: Vmm, dir: string) {
  if (isJailed(record)) await chown(dir, firecracker.jailUid(record.slot), firecracker.jailUid(record.slot))
}

export async function startNetwork(record: Vmm) {
  if (isJailed(record)) await createNamespace(record.slot, firecracker.jailUid(record.slot))
  else await createTap(record.slot)
  await setProxied(hostInterface(record), record.egress.mode === 'allowlist')
}

const metadataFile = (id: string) => `${vmDir(id)}/metadata.json`

// A cold boot. The metadata in the VM's directory is also what vm-stop reads.
export async function launch(record: VmRecord, resumeSessions = false) {
  const meta = JSON.stringify(metadata(record, resumeSessions))
  await Bun.write(metadataFile(record.id), meta, { mode: 0o600 })
  const spec = {
    id: record.id, hostname: record.name, vcpus: record.vcpus, memMib: record.memMib,
    kernel: isJailed(record) ? firecracker.IN_JAIL.kernel : record.kernel,
    rootDevice: rootDrivePath(record),
    ...slotAddresses(record.slot),
    tap: tapName(record),
  }
  if (isJailed(record)) {
    const uid = firecracker.jailUid(record.slot)
    await firecracker.prepareJail({
      id: record.id, uid, kernel: record.kernel, rootDevice: zfs.zvolDevice(rootVolume(record.id)),
      files: { 'config.json': JSON.stringify(firecracker.firecrackerConfig(spec)), 'metadata.json': meta },
    })
    await firecracker.launchJailed({
      id: record.id, uid, netns: namespaceAddresses(record.slot).netns, metadata: metadataFile(record.id),
      args: ['--config-file', firecracker.IN_JAIL.config, '--metadata', firecracker.IN_JAIL.metadata],
    })
    return
  }
  const config = `${vmDir(record.id)}/firecracker.json`
  await Bun.write(config, JSON.stringify(firecracker.firecrackerConfig(spec), null, 2))
  const root = record.rootPath ? { source: zfs.zvolDevice(rootVolume(record.id)), target: record.rootPath } : undefined
  await firecracker.launch(spec, { config, metadata: metadataFile(record.id) }, root)
}

// A running VM's metadata, replaced in place: a warm pool VM's new name.
export async function updateMetadata(record: VmRecord) {
  const meta = metadata(record)
  await Bun.write(metadataFile(record.id), JSON.stringify(meta), { mode: 0o600 })
  await firecracker.api(record.id)('PUT /mmds', meta)
}

// A fresh, unconfigured Firecracker to load a save into.
export async function launchForRestore(record: VmRecord) {
  const meta = JSON.stringify(metadata(record))
  await Bun.write(metadataFile(record.id), meta, { mode: 0o600 })
  if (isJailed(record)) {
    const uid = firecracker.jailUid(record.slot)
    await firecracker.prepareJail({ id: record.id, uid, rootDevice: zfs.zvolDevice(rootVolume(record.id)), files: { 'metadata.json': meta } })
    await firecracker.launchJailed({ id: record.id, uid, netns: namespaceAddresses(record.slot).netns, metadata: metadataFile(record.id), args: [] })
    return
  }
  const root = record.rootPath ? { source: zfs.zvolDevice(rootVolume(record.id)), target: record.rootPath } : undefined
  await firecracker.launchForRestore(record.id, metadataFile(record.id), root)
}
