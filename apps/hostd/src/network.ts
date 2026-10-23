import { $ } from 'bun'
import { sh } from './sh.ts'

// Each VM gets slot N: its own /30 inside 172.30.0.0/16, with the host at
// .1 and the guest at .2 of that /30, on TAP device sbxN.
export const VM_NETWORK = '172.30.0.0/16'
export const MAX_SLOTS = 16_384
const BASE = ((172 << 24) | (30 << 16)) >>> 0

export type SlotAddresses = {
  tap: string
  hostIp: string
  guestIp: string
  mac: string
}

export function slotAddresses(slot: number): SlotAddresses {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOTS) throw new Error(`bad slot ${slot}`)
  const network = BASE + slot * 4
  return {
    tap: `sbx${slot}`,
    hostIp: ipv4(network + 1),
    guestIp: ipv4(network + 2),
    // Locally administered, and unique because it embeds the guest IP.
    mac: ['06', '00', ...octets(network + 2).map((o) => o.toString(16).padStart(2, '0'))].join(':'),
  }
}

export function lowestFreeSlot(used: Iterable<number>): number {
  const taken = new Set(used)
  for (let slot = 0; slot < MAX_SLOTS; slot++) if (!taken.has(slot)) return slot
  throw new Error('no free VM slots')
}

function octets(n: number) {
  return [24, 16, 8, 0].map((shift) => (n >>> shift) & 255)
}

function ipv4(n: number) {
  return octets(n).join('.')
}

// VMs reach the internet through NAT and nothing else: not the host, not each
// other, not the VPC, and not the host's instance metadata (which would hand
// out the host's AWS credentials). Firecracker answers the guest's own
// metadata requests before they ever reach the TAP device.
export function firewallRules(uplink: string) {
  return `table inet substrate
delete table inet substrate
table inet substrate {
  chain input {
    type filter hook input priority filter; policy accept;
    iifname "sbx*" ct state established,related accept
    iifname "sbx*" drop
  }
  chain forward {
    type filter hook forward priority filter; policy accept;
    iifname "sbx*" ip daddr { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } drop
    iifname "sbx*" oifname "${uplink}" accept
    iifname "sbx*" drop
    oifname "sbx*" ct state established,related accept
    oifname "sbx*" drop
  }
  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    ip saddr ${VM_NETWORK} oifname "${uplink}" masquerade
  }
}
`
}

export async function defaultUplink(): Promise<string> {
  const routes = JSON.parse(await sh`ip -j route show default`) as { dev?: string }[]
  const dev = routes[0]?.dev
  if (!dev) throw new Error('no default route')
  return dev
}

// From a file: nft refuses to read rules from a piped stdin.
export async function applyFirewall(uplink: string, runDir: string) {
  const file = `${runDir}/firewall.nft`
  await Bun.write(file, firewallRules(uplink))
  await sh`nft -f ${file}`
}

export async function createTap(slot: number) {
  const { tap, hostIp } = slotAddresses(slot)
  await deleteTap(slot)
  await sh`ip tuntap add dev ${tap} mode tap`
  await sh`ip addr add ${hostIp}/30 dev ${tap}`
  await sh`ip link set ${tap} up`
}

export async function deleteTap(slot: number) {
  await $`ip link del ${slotAddresses(slot).tap}`.quiet().nothrow()
}
