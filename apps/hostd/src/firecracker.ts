import { $ } from 'bun'
import { rm } from 'node:fs/promises'
import { config } from './config.ts'
import { sh } from './sh.ts'

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
    'network-interfaces': [{ iface_id: 'eth0', guest_mac: spec.mac, host_dev_name: spec.tap }],
    'mmds-config': { version: 'V2', network_interfaces: ['eth0'], ipv4_address: '169.254.169.254' },
    // virtio-rng, so the guest never waits on entropy during boot.
    entropy: {},
  }
}

export const unitName = (id: string) => `substrate-vm-${id}`
export const apiSocket = (id: string) => `${config.paths.run}/${id}.sock`

// Each VM runs in its own transient systemd unit, so restarting hostd never
// touches running VMs. Serial console output goes to the unit's journal.
// Stopping the unit, from hostd or because the host is shutting down, runs
// vm-stop first, which shuts the guest down cleanly so no writes are lost.
export async function launch(spec: LaunchSpec, files: { config: string; metadata: string }) {
  const socket = apiSocket(spec.id)
  await rm(socket, { force: true })
  await sh`systemd-run --unit=${unitName(spec.id)} --description=${`Substrate VM ${spec.id}`} --collect --quiet ${`--property=ExecStop=${config.vmStop} ${files.metadata}`} --property=TimeoutStopSec=30 --property=After=zfs.target -- ${config.firecracker} --api-sock ${socket} --config-file ${files.config} --metadata ${files.metadata} --level Warning`
}

export async function isRunning(id: string) {
  const state = (await $`systemctl show -p ActiveState --value ${unitName(id)}`.quiet().nothrow()).text().trim()
  return state === 'active' || state === 'activating' || state === 'deactivating'
}

// A clean shutdown through the unit's ExecStop; returns once the VM is down.
export async function stop(id: string) {
  await $`systemctl stop ${unitName(id)}`.quiet().nothrow()
}

// Skips the clean shutdown, for VMs that are being deleted or never booted.
export async function kill(id: string) {
  await $`systemctl kill --signal=SIGKILL ${unitName(id)}`.quiet().nothrow()
  for (let i = 0; i < 50 && (await isRunning(id)); i++) await Bun.sleep(100)
}

export async function journalTail(id: string, lines = 25) {
  return (await $`journalctl -u ${unitName(id)} -n ${lines} --no-pager -o cat`.quiet().nothrow()).text().trim()
}
