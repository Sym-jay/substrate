// AWS acceptance using only VMs created by this run. Does not replace the
// firewall, restart hostd, or stop/start any existing workspace or EC2 host.
import { randomBytes, randomUUID } from 'node:crypto'
import { ExecResult, Session, Vm } from '@substrate/protocol'
import { run, stackOutputs } from './lib/aws.ts'
import { errorMessage, hostd } from './lib/hostd.ts'

const { HostInstanceId: host } = await stackOutputs()
const marker = randomUUID(), owned = new Set<string>()
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) throw new Error(`${label}${detail ? `: ${detail}` : ''}`)
  console.log(`ok ${label}${detail ? `: ${detail}` : ''}`)
}
async function call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
  const response = await hostd(host, method, path, body)
  if (response.status >= 400) throw new Error(errorMessage(response))
  return response.data
}
async function exec(vm: Vm, command: string) {
  const result = ExecResult.parse(await call('POST', `/vms/${vm.id}/exec`, { command, timeoutMs: 20_000 }))
  check('guest command completed', result.exitCode === 0, result.exitCode ? result.stderr.slice(-200) : '')
  return result.stdout.trim()
}
async function create(name: string, egress: 'open' | 'allowlist') {
  const id = `vm-${randomBytes(8).toString('hex')}`
  owned.add(id)
  const vm = Vm.parse(await call('POST', '/vms', { targetId: id, name: `phase2-${name}-${marker.slice(0, 6)}`, size: 'small', diskGib: 8, egress: { mode: egress, allow: ['example.com'] } }))
  check(`${name} jailed VM boots`, vm.state === 'running' && !vm.lastError, `${vm.bootMs} ms`)
  return vm
}
async function jail(vm: Vm) {
  const result = await run(host, `set -e
python3 - <<'PY'
import json,subprocess,os
vm_id='${vm.id}'
pid=subprocess.check_output(['systemctl','show','-p','MainPID','--value','substrate-vm-'+vm_id]).decode().strip()
assert pid != '0', 'VM unit has no process'
uid=os.stat('/proc/'+pid).st_uid
ns=subprocess.check_output(['ip','netns','identify',pid]).decode().strip()
assert uid >= 900000, 'Firecracker is not under a unique jail uid'
assert ns.startswith('sbxns'), 'VM is not in its own network namespace'
root='/proc/'+pid+'/root'
assert os.path.exists(root+'/config.json') and os.path.exists(root+'/rootfs')
assert not os.path.exists(root+'/etc/passwd') and not os.path.exists(root+'/var/lib')
print(json.dumps({'uid':uid,'namespace':ns,'jail':True}))
PY`, 30)
  if (!result.ok) throw new Error(result.stderr || result.stdout)
  const data = JSON.parse(result.stdout) as { uid: number; namespace: string; jail: boolean }
  check('Firecracker uid, chroot and network namespace verified', data.jail)
  return data
}
async function terminal(vm: Vm, session: Session, phase: 'seed' | 'verify') {
  const source = Buffer.from(await Bun.file(new URL('./lib/m3-terminal-probe.ts', import.meta.url)).text()).toString('base64')
  const path = `/tmp/substrate-phase2-terminal-${marker}.ts`
  const result = await run(host, ['set -e', `trap 'rm -f ${path}' EXIT`,
    `printf %s '${source}' | base64 -d > '${path}'`,
    `export PATH="$PATH:/usr/local/bin"`, `bun '${path}' '${vm.id}' '${session.id}' '${phase}' '${marker}'`,
  ].join('\n'), 30)
  if (!result.ok) throw new Error(result.stderr || result.stdout)
  return JSON.parse(result.stdout) as { pid: number; memory: boolean; disk: boolean; scrollback: boolean }
}

try {
  const open = await create('open', 'open'), allow = await create('allow', 'allowlist')
  const first = await jail(open), second = await jail(allow)
  check('VMs have distinct uids and namespaces', first.uid !== second.uid && first.namespace !== second.namespace)
  check('open guest reaches public HTTPS', await exec(open, "curl --noproxy '*' -sS -m 12 -o /dev/null -w '%{http_code}' https://example.com") === '200')
  check('allowlisted guest has proxy configured by metadata', (await exec(allow, 'test -r /etc/profile.d/substrate-proxy.sh && . /etc/profile.d/substrate-proxy.sh && test -n "$https_proxy" && echo configured')) === 'configured')
  check('allowlisted guest cannot reach public internet directly', await exec(allow, "curl --noproxy '*' -s -m 5 -o /dev/null -w '%{http_code}' https://1.1.1.1 || true") === '000')
  check('allowlisted guest reaches an allowed HTTPS host through proxy', await exec(allow, ". /etc/profile.d/substrate-proxy.sh; curl -sS -m 12 -o /dev/null -w '%{http_code}' https://example.com") === '200')
  check('proxy rejects a domain outside the allowlist', await exec(allow, ". /etc/profile.d/substrate-proxy.sh; curl -s -m 5 -o /dev/null -w '%{http_connect}' https://www.google.com || true") === '403')
  check('proxy rejects EC2 metadata', await exec(allow, ". /etc/profile.d/substrate-proxy.sh; curl --noproxy '' -s -m 5 -o /dev/null -w '%{http_code}' http://169.254.169.254/latest/meta-data/ || true") === '403')
  check('one guest cannot reach another guest', await exec(open, `timeout 3 bash -c '</dev/tcp/${allow.guestIp}/22' >/dev/null 2>&1 && echo reached || echo blocked`) === 'blocked')
  const slot = first.uid - 900000, hostAddress = `172.31.${Math.floor(slot * 4 / 256)}.${slot * 4 % 256 + 1}`
  check('guest cannot reach host SSH', await exec(open, `timeout 3 bash -c '</dev/tcp/${hostAddress}/22' >/dev/null 2>&1 && echo reached || echo blocked`) === 'blocked')
  const session = Session.parse(await call('POST', `/vms/${open.id}/sessions`, {}))
  const before = await terminal(open, session, 'seed')
  const paused = Vm.parse(await call('POST', `/vms/${open.id}/pause`))
  check('jailed VM creates durable ZFS/memory snapshot', paused.state === 'paused', `${paused.pauseMs} ms`)
  const resumed = Vm.parse(await call('POST', `/vms/${open.id}/resume`))
  check('jailed VM resumes', resumed.state === 'running' && !resumed.lastError, `${resumed.resumeMs} ms`)
  const after = await terminal(open, session, 'verify')
  check('restored terminal retains process, shell memory, disk and scrollback', after.pid === before.pid && after.memory && after.disk && after.scrollback)
  await jail(resumed)
  const childId = `vm-${randomBytes(8).toString('hex')}`
  owned.add(childId)
  const child = Vm.parse(await call('POST', `/vms/${open.id}/fork`, { targetId: childId, name: `phase2-fork-${marker.slice(0, 6)}` }))
  check('jailed running-state fork succeeds', child.state === 'running' && !child.lastError)
  const third = await jail(child)
  check('fork has its own jail identity and namespace', third.uid !== first.uid && third.uid !== second.uid)
  const inherited = await terminal(child, session, 'verify')
  check('fork retains the source shell memory and scrollback', inherited.memory && inherited.disk && inherited.scrollback)
  check('fork writes are isolated', await exec(child, `printf fork-only > ~/phase2-fork-${marker}`) === '' && await exec(open, `test ! -e ~/phase2-fork-${marker} && echo isolated`) === 'isolated')
} finally {
  const failures: string[] = []
  for (const id of [...owned].reverse()) {
    try { const response = await hostd(host, 'DELETE', `/vms/${id}`); if (![204, 404].includes(response.status)) throw new Error(errorMessage(response)) }
    catch (error) { failures.push(`${id}: ${error instanceof Error ? error.message : 'cleanup failed'}`) }
  }
  if (failures.length) throw new Error(`Temporary VM cleanup needs attention: ${failures.join('; ')}`)
  console.log('temporary Phase 2 VMs removed')
}
