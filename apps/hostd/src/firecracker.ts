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
export async function launch(spec: LaunchSpec, files: { config: string; metadata: string }) {
  const socket = apiSocket(spec.id)
  await rm(socket, { force: true })
  await sh`systemd-run --unit=${unitName(spec.id)} --description=${`Substrate VM ${spec.id}`} --collect --quiet -- ${config.firecracker} --api-sock ${socket} --config-file ${files.config} --metadata ${files.metadata} --level Warning`
}

export async function isRunning(id: string) {
  const state = (await $`systemctl show -p ActiveState --value ${unitName(id)}`.quiet().nothrow()).text().trim()
  return state === 'active' || state === 'activating' || state === 'deactivating'
}

// Asks the guest to shut down cleanly; with reboot=k Firecracker then exits.
export async function sendCtrlAltDel(id: string) {
  const res = await fetch('http://localhost/actions', {
    unix: apiSocket(id),
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action_type: 'SendCtrlAltDel' }),
  })
  if (!res.ok) throw new Error(`SendCtrlAltDel failed: ${res.status} ${await res.text()}`)
}

export async function kill(id: string) {
  await $`systemctl stop ${unitName(id)}`.quiet().nothrow()
}

export async function journalTail(id: string, lines = 25) {
  return (await $`journalctl -u ${unitName(id)} -n ${lines} --no-pager -o cat`.quiet().nothrow()).text().trim()
}
