import { $ } from 'bun'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { config } from './config.ts'
import { sh } from './sh.ts'
import { firecrackerClient } from './firecracker-api.ts'

export type LaunchSpec = {
  id: string
  hostname: string
  vcpus: number
  memMib: number
  kernel: string
  rootDevice: string
  tap: string
  mac: string
  guestIp: string
  hostIp: string
}

export function bootArgs(spec: Pick<LaunchSpec, 'guestIp' | 'hostIp' | 'hostname'>) {
  return [
    'console=ttyS0',
    'reboot=k',
    'panic=1',
    'pci=off',
    'quiet',
    // Firecracker's i8042 only exists to deliver Ctrl+Alt+Del for a clean shutdown.
    'i8042.noaux',
    'i8042.nomux',
    'i8042.nopnp',
    'i8042.dumbkbd',
    // client-ip::gateway:netmask:hostname:device:autoconf
    `ip=${spec.guestIp}::${spec.hostIp}:255.255.255.252:${spec.hostname}:eth0:off`,
  ].join(' ')
}

// The --config-file format mirrors Firecracker's API request bodies:
// https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/src/firecracker/swagger/firecracker.yaml
export function firecrackerConfig(spec: LaunchSpec) {
  return {
    'boot-source': { kernel_image_path: spec.kernel, boot_args: bootArgs(spec) },
    drives: [
      {
        drive_id: 'rootfs',
        path_on_host: spec.rootDevice,
        is_root_device: true,
        is_read_only: false,
        // Pass the guest's flushes through to ZFS, so a synced write is durable.
        cache_type: 'Writeback',
      },
    ],
    'machine-config': { vcpu_count: spec.vcpus, mem_size_mib: spec.memMib, smt: false },
    balloon: {
      amount_mib: Math.max(0, spec.memMib - 4096),
      deflate_on_oom: true,
      stats_polling_interval_s: 1,
      free_page_reporting: true,
    },
    'network-interfaces': [{ iface_id: 'eth0', guest_mac: spec.mac, host_dev_name: spec.tap }],
    'mmds-config': { version: 'V2', network_interfaces: ['eth0'], ipv4_address: '169.254.169.254' },
    // virtio-rng, so the guest never waits on entropy during boot.
    entropy: {},
  }
}

export const unitName = (id: string) => `substrate-vm-${id}`
const unjailedSocket = (id: string) => `${config.paths.run}/${id}.sock`

// ── The jailer ──
// A jailed VM's Firecracker runs as a uid of its own, chrooted into a
// directory on the VM's own dataset, inside the VM's network namespace. The
// jailer's --id is the same for every VM ('vm'): each VM has its own chroot
// base, so paths inside the chroot are the same for all of them, and a fork's
// copy of its parent's chroot (snapshot files and all) works as it is. The
// jailer only makes cgroups when asked to, which it isn't.
const JAIL_ID = 'vm'
export const jailBase = (id: string) => `${config.paths.vms}/${id}/jail`
export const jailRoot = (id: string) => `${jailBase(id)}/firecracker/${JAIL_ID}/root`
// The VM's uid and gid, unique among VMs while they exist.
export const jailUid = (slot: number) => 900_000 + slot
// What the jailer itself puts in the chroot. It won't start over its own
// leftovers (on arm64 it copies CPU cache details into sys/ and fails on
// EEXIST), so they go before every launch.
const JAILER_ARTIFACTS = ['dev', 'sys', 'run', 'firecracker', 'firecracker.pid', 'api.sock']
// Paths as the jailed Firecracker sees them.
export const IN_JAIL = { kernel: '/vmlinux', rootfs: '/rootfs', config: '/config.json', metadata: '/metadata.json', socket: '/api.sock' } as const

// The VM's API socket: in its chroot if it's jailed. Resolved on every call,
// so callers needn't know which kind of VM they have.
export const apiSocket = (id: string) => {
  const jailed = `${jailRoot(id)}${IN_JAIL.socket}`
  return existsSync(jailed) ? jailed : unjailedSocket(id)
}

// Readies a jailed VM's chroot: its kernel, a device node for its disk, its
// config and metadata, all owned by its uid.
// A restore needs no kernel: it's in the save.
export async function prepareJail(input: { id: string; uid: number; kernel?: string; rootDevice: string; files: Record<string, string> }) {
  const root = jailRoot(input.id)
  await mkdir(`${root}/snapshots`, { recursive: true, mode: 0o700 })
  for (const name of JAILER_ARTIFACTS) await rm(`${root}/${name}`, { recursive: true, force: true })
  await rm(unjailedSocket(input.id), { force: true })
  if (input.kernel) {
    await copyFile(input.kernel, `${root}${IN_JAIL.kernel}`)
    await chmod(`${root}${IN_JAIL.kernel}`, 0o400)
  }
  // The zvol's own node (/dev/zdN) belongs to root; the VM gets a private
  // node for the same device. A fork's zvol has a different minor, so it's
  // made anew every time.
  const [major, minor] = (await sh`stat -L -c ${'%t %T'} ${input.rootDevice}`).trim().split(' ').map((hex) => Number.parseInt(hex, 16))
  await rm(`${root}${IN_JAIL.rootfs}`, { force: true })
  await sh`mknod -m 600 ${`${root}${IN_JAIL.rootfs}`} b ${major} ${minor}`
  for (const [name, content] of Object.entries(input.files)) await Bun.write(`${root}/${name}`, content, { mode: 0o600 })
  await sh`chown -R ${`${input.uid}:${input.uid}`} ${root}`
}

export async function launchJailed(input: { id: string; uid: number; netns: string; metadata: string; args: string[] }) {
  await sh`systemd-run --unit=${unitName(input.id)} --description=${`Substrate VM ${input.id} (jailed)`} --collect --quiet ${`--property=ExecStop=${config.vmStop} ${input.metadata}`} --property=TimeoutStopSec=30 --property=After=zfs.target -- ${config.jailer} --id ${JAIL_ID} --exec-file ${config.firecracker} --uid ${input.uid} --gid ${input.uid} --chroot-base-dir ${jailBase(input.id)} --netns ${`/var/run/netns/${input.netns}`} -- --api-sock ${IN_JAIL.socket} ${input.args} --level Warning`
}

// Each VM runs in its own transient systemd unit, so restarting hostd never
// touches running VMs. Serial console output goes to the unit's journal.
// Stopping the unit, from hostd or because the host is shutting down, runs
// vm-stop first, which shuts the guest down cleanly so no writes are lost.
export async function launch(spec: LaunchSpec, files: { config: string; metadata: string }, root?: { source: string; target: string }) {
  return launchProcess(spec.id, files.metadata, ['--config-file', files.config, '--metadata', files.metadata], root)
}

// Snapshot loading requires a fresh, unconfigured Firecracker process.
export async function launchForRestore(id: string, metadata: string, root?: { source: string; target: string }) {
  return launchProcess(id, metadata, [], root)
}

async function launchProcess(id: string, metadata: string, args: string[], root?: { source: string; target: string }) {
  const socket = unjailedSocket(id)
  await rm(socket, { force: true })
  await rm(`${jailRoot(id)}${IN_JAIL.socket}`, { force: true })
  if (root) await Bun.write(root.target, '', { mode: 0o600 })
  const mounts = root ? ['--property=PrivateMounts=yes', `--property=BindPaths=${root.source}:${root.target}`] : []
  await sh`systemd-run --unit=${unitName(id)} --description=${`Substrate VM ${id}`} --collect --quiet ${`--property=ExecStop=${config.vmStop} ${metadata}`} --property=TimeoutStopSec=30 --property=After=zfs.target ${mounts} -- ${config.firecracker} --api-sock ${socket} ${args} --level Warning`
}

export const api = (id: string) => firecrackerClient(apiSocket(id))

export async function waitForApi(id: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try { return await api(id)('GET /', undefined, 500) }
    catch (error) {
      if (Date.now() >= deadline) throw error
      await Bun.sleep(10)
    }
  }
}

export async function isRunning(id: string) {
  const state = (await $`systemctl show -p ActiveState --value ${unitName(id)}`.quiet().nothrow()).text().trim()
  return state === 'active' || state === 'activating' || state === 'deactivating'
}

export function parseMemoryUsage(text: string) {
  const read = (field: string) => {
    const match = new RegExp(`^${field}:\\s+(\\d+) kB$`, 'm').exec(text)
    return match ? Number(match[1]) / 1024 : null
  }
  return { residentMib: read('Rss'), proportionalMib: read('Pss') }
}

export async function memoryUsage(id: string) {
  const pid = (await $`systemctl show -p MainPID --value ${unitName(id)}`.quiet().nothrow()).text().trim()
  if (!/^[1-9]\d*$/.test(pid)) return { residentMib: null, proportionalMib: null }
  return readFile(`/proc/${pid}/smaps_rollup`, 'utf8').then(parseMemoryUsage, () => ({ residentMib: null, proportionalMib: null }))
}

// A clean shutdown through the unit's ExecStop; returns once the VM is down.
export async function stop(id: string) {
  await $`systemctl stop ${unitName(id)}`.quiet().nothrow()
}

// Skips the clean shutdown, for VMs that are being deleted or never booted.
export async function kill(id: string) {
  await $`systemctl kill --kill-whom=all --signal=SIGKILL ${unitName(id)}`.quiet().nothrow()
  for (let i = 0; i < 50 && (await isRunning(id)); i++) await Bun.sleep(100)
  if (await isRunning(id)) throw new Error(`Firecracker ${id} did not stop`)
}

export async function journalTail(id: string, lines = 25) {
  return (await $`journalctl -u ${unitName(id)} -n ${lines} --no-pager -o cat`.quiet().nothrow()).text().trim()
}
