import { $ } from 'bun'
import { sh } from './sh.ts'

// Each VM gets slot N: its own /30 inside 172.30.0.0/16, with the host at
// .1 and the guest at .2 of that /30, on TAP device sbxN.
//
// A jailed VM (see firecracker.ts) has a network namespace of its own,
// sbxnsN, holding its TAP (tap0, with the same addresses) and one end of a
// veth pair; the other end, vhN, is in the host's namespace, on another /30
// from 172.31.0.0/16. The host routes the guest's /30 through it.
export const VM_NETWORK = '172.30.0.0/16'
export const VETH_NETWORK = '172.31.0.0/16'
export const MAX_SLOTS = 16_384
const BASE = ((172 << 24) | (30 << 16)) >>> 0
const VETH_BASE = ((172 << 24) | (31 << 16)) >>> 0
// Every guest's HTTP(S) proxy for allowlisted egress (see egress.ts).
export const PROXY_PORT = 3128

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

// The jailed VM's namespace and the veth pair joining it to the host.
export function namespaceAddresses(slot: number) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOTS) throw new Error(`bad slot ${slot}`)
  const network = VETH_BASE + slot * 4
  return {
    netns: `sbxns${slot}`,
    hostVeth: `vh${slot}`,
    nsVeth: `vn${slot}`,
    vethHostIp: ipv4(network + 1),
    vethNsIp: ipv4(network + 2),
    // Inside the namespace, so every jailed VM's TAP has the same name: a
    // snapshot made in one namespace loads in another (forks).
    tap: 'tap0',
  }
}

// The slot whose guest has this address, if any.
export function slotOfGuest(ip: string) {
  const parts = ip.replace(/^::ffff:/, '').split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null
  const n = (((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0) - BASE
  return n >= 0 && n % 4 === 2 && (n - 2) / 4 < MAX_SLOTS ? (n - 2) / 4 : null
}

// Where a guest finds the egress proxy: an address on the host it can reach.
export function proxyAddress(slot: number, jailed: boolean) {
  return jailed ? namespaceAddresses(slot).vethHostIp : slotAddresses(slot).hostIp
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
//
// sbx* are unjailed VMs' TAPs and vh* jailed VMs' veths; both get the same
// rules. A VM whose interface is in @proxied (allowlisted egress) can't go
// out directly at all: only to the egress proxy on the host.
export function firewallRules(uplink: string) {
  const vmRules = (dev: string) => ({
    input: [
      `iifname "${dev}" ct state established,related accept`,
      `iifname "${dev}" tcp dport ${PROXY_PORT} accept`,
      `iifname "${dev}" drop`,
    ],
    forward: [
      `iifname "${dev}" ip daddr { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } drop`,
      `iifname "${dev}" oifname "${uplink}" accept`,
      `iifname "${dev}" drop`,
      `oifname "${dev}" ct state established,related accept`,
      `oifname "${dev}" drop`,
    ],
  })
  const sbx = vmRules('sbx*')
  const vh = vmRules('vh*')
  return `table inet substrate
delete table inet substrate
table inet substrate {
  set proxied {
    type ifname
  }
  chain input {
    type filter hook input priority filter; policy accept;
    ${[...sbx.input, ...vh.input].join('\n    ')}
  }
  chain forward {
    type filter hook forward priority filter; policy accept;
    iifname @proxied drop
    ${[...sbx.forward, ...vh.forward].join('\n    ')}
  }
  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    ip saddr ${VM_NETWORK} oifname "${uplink}" masquerade
  }
}
`
}

// A VM with allowlisted egress: direct traffic out is dropped, so it must use
// the proxy. Its interface leaves the set when its network is torn down.
export async function setProxied(dev: string, proxied: boolean) {
  const action = proxied ? 'add' : 'delete'
  const result = await $`nft ${action} element inet substrate proxied ${`{ ${dev} }`}`.quiet().nothrow()
  // Deleting an interface that isn't in the set isn't an error worth reporting.
  if (result.exitCode !== 0 && proxied) throw new Error(`nft add element failed: ${result.stderr.toString().trim()}`)
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

// The jailed VM's namespace: its TAP, owned by the VM's own uid so the jailed
// Firecracker can open it, and the veth pair out to the host.
export async function createNamespace(slot: number, uid: number) {
  const { hostIp } = slotAddresses(slot)
  const ns = namespaceAddresses(slot)
  await deleteTap(slot)
  const inNs = (...argv: string[]) => sh`ip netns exec ${ns.netns} ${argv}`
  await sh`ip netns add ${ns.netns}`
  await sh`ip link add ${ns.hostVeth} type veth peer name ${ns.nsVeth}`
  await sh`ip link set ${ns.nsVeth} netns ${ns.netns}`
  await sh`ip addr add ${ns.vethHostIp}/30 dev ${ns.hostVeth}`
  await sh`ip link set ${ns.hostVeth} up`
  await inNs('ip', 'link', 'set', 'lo', 'up')
  await inNs('ip', 'addr', 'add', `${ns.vethNsIp}/30`, 'dev', ns.nsVeth)
  await inNs('ip', 'link', 'set', ns.nsVeth, 'up')
  await inNs('ip', 'tuntap', 'add', 'dev', ns.tap, 'mode', 'tap', 'user', String(uid), 'group', String(uid))
  await inNs('ip', 'addr', 'add', `${hostIp}/30`, 'dev', ns.tap)
  await inNs('ip', 'link', 'set', ns.tap, 'up')
  await inNs('ip', 'route', 'add', 'default', 'via', ns.vethHostIp)
  await inNs('sysctl', '-qw', 'net.ipv4.ip_forward=1')
  await sh`ip route replace ${`${slotNetwork(slot)}/30`} via ${ns.vethNsIp} dev ${ns.hostVeth}`
}

// Removes whatever the slot has: a TAP, or a namespace and its veth pair.
export async function deleteTap(slot: number) {
  const ns = namespaceAddresses(slot)
  await $`ip link del ${slotAddresses(slot).tap}`.quiet().nothrow()
  await $`ip link del ${ns.hostVeth}`.quiet().nothrow()
  await $`ip netns del ${ns.netns}`.quiet().nothrow()
}

const slotNetwork = (slot: number) => ipv4(BASE + slot * 4)
