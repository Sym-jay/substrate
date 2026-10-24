// Checks Phase 2's VM isolation with hostd's own code, on any Linux machine
// with KVM, Firecracker and the jailer (the host, or a dev VM):
//   sudo SUBSTRATE_ROOT=/var/lib/sbxcheck bun scripts/check-isolation.ts \
//     --kernel vmlinux --disk rootfs.ext4 --key id_ed25519
// It boots two jailed VMs from copies of the disk (root's SSH key must be
// authorized in it): one with allowlisted egress, one open. Then it checks:
//   - each runs as its own uid, chrooted, in its own network namespace
//   - the allowlisted one can't get out except through the proxy, and the
//     proxy only lets it reach its allowlist, never the metadata service
//   - neither can reach the other, or the host beyond the proxy
// Everything it made is removed afterwards.
import { $ } from 'bun'
import { mkdir, rm } from 'node:fs/promises'
import { startEgressProxy } from '../apps/hostd/src/egress.ts'
import * as firecracker from '../apps/hostd/src/firecracker.ts'
import { applyFirewall, createNamespace, defaultUplink, deleteTap, namespaceAddresses, PROXY_PORT, setProxied, slotAddresses, slotOfGuest } from '../apps/hostd/src/network.ts'

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1 || !process.argv[i + 1]) throw new Error(`--${name} is required`)
  return process.argv[i + 1]!
}
const kernel = arg('kernel')
const disk = arg('disk')
const key = arg('key')
const root = process.env.SUBSTRATE_ROOT
if (!root || !root.startsWith('/var/lib/sbx')) throw new Error('set SUBSTRATE_ROOT to a scratch directory under /var/lib/sbx…')

const vms = [
  { slot: 0, id: 'vm-checkallow', egress: 'allowlist' as const },
  { slot: 1, id: 'vm-checkopen', egress: 'open' as const },
].map((vm) => ({ ...vm, uid: firecracker.jailUid(vm.slot), net: slotAddresses(vm.slot), ns: namespaceAddresses(vm.slot), loop: '' }))

const failures: string[] = []
const check = (ok: boolean, what: string, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail ? `: ${detail}` : ''}`)
  if (!ok) failures.push(what)
}
const ssh = (vm: (typeof vms)[number], command: string) =>
  $`ssh -i ${key} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o LogLevel=ERROR root@${vm.net.guestIp} ${command}`.quiet().nothrow()

const proxy = startEgressProxy({
  port: PROXY_PORT,
  grantFor: async (ip) => {
    const vm = vms.find((v) => v.slot === slotOfGuest(ip))
    return vm ? { vmId: vm.id, allow: vm.egress === 'allowlist' ? ['example.com'] : 'any' } : null
  },
})

try {
  await mkdir(`${root}/vms`, { recursive: true })
  await applyFirewall(await defaultUplink(), root)
  for (const vm of vms) {
    await $`cp --sparse=always ${disk} ${`${root}/${vm.id}.ext4`}`
    vm.loop = (await $`losetup -f --show ${`${root}/${vm.id}.ext4`}`.text()).trim()
    await createNamespace(vm.slot, vm.uid)
    const spec = { id: vm.id, hostname: vm.id, vcpus: 1, memMib: 512, kernel: firecracker.IN_JAIL.kernel, rootDevice: firecracker.IN_JAIL.rootfs, ...vm.net, tap: vm.ns.tap }
    const config = firecracker.firecrackerConfig(spec)
    // The test kernel has no balloon or entropy device needs; keep the rest as hostd sends it.
    await firecracker.prepareJail({ id: vm.id, uid: vm.uid, kernel, rootDevice: vm.loop, files: { 'config.json': JSON.stringify(config), 'metadata.json': '{}' } })
    await firecracker.launchJailed({ id: vm.id, uid: vm.uid, netns: vm.ns.netns, metadata: '/dev/null', args: ['--config-file', firecracker.IN_JAIL.config] })
    await setProxied(vm.ns.hostVeth, vm.egress === 'allowlist')
  }
  for (const vm of vms) {
    let up = false
    for (let i = 0; i < 40 && !up; i++) up = (await ssh(vm, 'true')).exitCode === 0 || (await Bun.sleep(500), false)
    check(up, `${vm.id} boots and answers SSH from the host`)
    await ssh(vm, 'echo nameserver 1.1.1.1 > /etc/resolv.conf')
    const pid = (await $`systemctl show -p MainPID --value ${firecracker.unitName(vm.id)}`.text()).trim()
    const owner = (await $`stat -c %u /proc/${pid}`.text()).trim()
    check(owner === String(vm.uid), `${vm.id}'s Firecracker runs as its own uid (${vm.uid})`, owner)
    // It pivots into its jail in a mount namespace of its own, so look at what
    // it sees: its own files, and nothing of the host's.
    const sees = (path: string) => $`test -e /proc/${pid}/root${path}`.quiet().nothrow().then((r) => r.exitCode === 0)
    check(await sees('/config.json') && await sees('/rootfs') && !(await sees('/etc/passwd')) && !(await sees('/var/lib')),
      `${vm.id}'s Firecracker sees only its jail`)
    const netns = (await $`ip netns identify ${pid}`.text()).trim()
    check(netns === vm.ns.netns, `${vm.id}'s Firecracker is in its own network namespace`, netns)
  }
  const [allow, open] = vms as [(typeof vms)[number], (typeof vms)[number]]
  const proxyUrl = `http://${allow.ns.vethHostIp}:${PROXY_PORT}`
  const code = async (vm: (typeof vms)[number], curl: string) => (await ssh(vm, `curl -s -m 8 -o /dev/null -w '%{http_code}' ${curl}`)).stdout.toString().trim()
  check(await code(allow, 'http://1.1.1.1') === '000', "the allowlisted VM can't go out directly")
  check(await code(allow, `-x ${proxyUrl} https://example.com`) === '200', 'it reaches an allowlisted host through the proxy')
  const refused = (await ssh(allow, `curl -s -m 8 -o /dev/null -w '%{http_connect}' -x ${proxyUrl} https://www.google.com`)).stdout.toString().trim()
  check(refused === '403', 'the proxy refuses a host not on its list', refused)
  check(await code(allow, `-x ${proxyUrl} http://169.254.169.254/latest/meta-data/`) === '403', "the proxy won't reach the metadata service")
  check(await code(open, 'https://example.com') === '200', 'the open VM goes out directly')
  const openMeta = await code(open, `-x http://${open.ns.vethHostIp}:${PROXY_PORT} http://169.254.169.254/latest/meta-data/`)
  check(openMeta === '403', "even for an open VM, the proxy won't reach the metadata service", openMeta)
  const across = await ssh(open, `timeout 3 bash -c '</dev/tcp/${allow.net.guestIp}/22' && echo reached || echo blocked`)
  check(across.stdout.toString().trim() === 'blocked', "one VM can't reach another")
  const hostSsh = await ssh(allow, `timeout 3 bash -c '</dev/tcp/${allow.ns.vethHostIp}/22' && echo reached || echo blocked`)
  check(hostSsh.stdout.toString().trim() === 'blocked', "a VM can't reach the host's own services")
} finally {
  proxy.stop(true)
  for (const vm of vms) {
    await firecracker.kill(vm.id).catch(() => {})
    await deleteTap(vm.slot)
    if (vm.loop) await $`losetup -d ${vm.loop}`.quiet().nothrow()
  }
  await $`nft delete table inet substrate`.quiet().nothrow()
  await rm(root, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`${failures.length} check${failures.length === 1 ? '' : 's'} failed`)
  process.exit(1)
}
console.log('all isolation checks passed')
