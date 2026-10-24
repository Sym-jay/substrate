// Baseline/optimized AWS measurements. Only test VMs are changed. --host-cycle
// permits stopped existing VMs, whose metadata hashes must remain unchanged;
// it refuses if another VM is active or any deployment/image build is running.
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { StartInstancesCommand, StopInstancesCommand } from '@aws-sdk/client-ec2'
import { ec2, instanceState, run, stackOutputs, waitForSsm } from './lib/aws.ts'
import { hostd, errorMessage } from './lib/hostd.ts'

const cycle = process.argv.includes('--host-cycle')
const option = (name: string, fallback: string) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback
const label = option('--label', 'sample'), repeats = Number(option('--repeats', '3')), warm = Number(option('--warm', '5'))
if (!/^[a-z0-9-]+$/.test(label) || !Number.isInteger(repeats) || repeats < 1 || repeats > 10 || !Number.isInteger(warm) || warm < 1 || warm > 20) throw new Error('invalid benchmark options')
const out = await stackOutputs(), host = out.HostInstanceId, marker = randomUUID().slice(0, 8)
if (await instanceState(host) !== 'running') throw new Error('host must already be running')
const path = `.data/performance-${label}-${marker}.json`, owned = new Set<string>(), results: unknown[] = []
const retained: { id: string; size: string; sessionId: string; expectedPid: number }[] = []
let stopped = false
const lease = `substrate-performance-${marker}`
let version: string | null = null
let image: string | null = null
await mkdir('.data', { recursive: true })
const save = () => writeFile(path, JSON.stringify({ label, marker, hostCycle: cycle, owned: [...owned], results }, null, 2), { mode: 0o600 })
async function call(method: 'GET' | 'POST' | 'DELETE', route: string, body?: unknown) {
  const response = await hostd<any>(host, method, route, body)
  if (response.status >= 400) throw new Error(errorMessage(response))
  return response.data
}
async function probe(input: Record<string, unknown>) {
  const health = await call('GET', '/health')
  if (version && health.version !== version) throw new Error('host release changed during benchmark')
  if (image && health.image !== image) throw new Error('guest image changed during benchmark')
  const source = Buffer.from(await Bun.file(new URL('./lib/vm-performance-probe.ts', import.meta.url)).text()).toString('base64')
  const remote = `/tmp/substrate-perf-${marker}.ts`, args = Buffer.from(JSON.stringify({ ...input, marker })).toString('base64')
  const response = await run(host, ['set -e', `trap 'unlink ${remote}' EXIT`, `printf %s '${source}' | base64 -d > '${remote}'`,
    `export PATH="$PATH:/usr/local/bin"`, `bun '${remote}' '${args}'`].join('\n'), 900)
  if (!response.ok) throw new Error(response.stderr || response.stdout || 'benchmark probe failed')
  const result = JSON.parse(response.stdout)
  results.push({ ...input, ...result }); await save()
  console.log(JSON.stringify({ ...input, samples: result.samples, profiles: result.profiles }))
  return result
}
async function metadata() {
  const response = await run(host, `python3 - <<'PY'
import glob,hashlib,json
print(json.dumps({p.split('/')[-2]:hashlib.sha256(open(p,'rb').read()).hexdigest() for p in glob.glob('/var/lib/substrate/vms/*/vm.json')}))
PY`, 30)
  if (!response.ok) throw new Error(response.stderr)
  return JSON.parse(response.stdout) as Record<string, string>
}
const baseline = await metadata()
const original = await call('GET', '/vms') as { id: string; state: string }[]
if (cycle && original.some(vm => vm.state !== 'stopped')) throw new Error('host cycle requires every preexisting VM to be stopped')
async function acquireLease() {
  // The regular deploy script uses this same flock. Expiration also releases
  // it if the local benchmark process is interrupted and cannot clean up.
  const response = await run(host, `set -e
systemd-run --unit=${lease} --collect --property=RuntimeMaxSec=1800 --quiet /usr/bin/flock -n /run/lock/substrate-host-deploy.lock /usr/bin/flock -n /run/lock/substrate-image-build.lock /bin/sleep 1800
sleep 1
systemctl is-active --quiet ${lease}`, 30)
  if (!response.ok) throw new Error('another deployment owns the host; benchmark did not acquire its lease')
}
async function waitState(state: string) {
  const end = Date.now() + 600_000
  while (await instanceState(host) !== state) { if (Date.now() > end) throw new Error(`host did not reach ${state}`); await Bun.sleep(5_000) }
}
try {
  await acquireLease()
  const initial = await call('GET', '/health')
  version = initial.version; image = initial.image
  results.push({ action: 'environment', version, image }); await save()
  for (const size of ['small', 'medium', 'large']) {
    for (let i = 0; i < repeats; i++) {
      const id = `vm-${randomBytes(8).toString('hex')}`
      owned.add(id); await save()
      const result = await probe({ action: 'create', id, size })
      if (i === 0) {
        retained.push({ id, size, sessionId: result.sessionId, expectedPid: result.samples[0].proof.pid })
        await probe({ action: 'diagnose', id, size })
        await probe({ action: 'warm', id, size, sessionId: result.sessionId, expectedPid: result.samples[0].proof.pid, iterations: warm })
        await call('POST', `/vms/${id}/pause`, {})
      } else { await call('DELETE', `/vms/${id}`); owned.delete(id); await save() }
    }
  }
  if (cycle) {
    const vms = await call('GET', '/vms') as { id: string; state: string }[]
    if (vms.some(vm => owned.has(vm.id) ? vm.state !== 'paused' : !baseline[vm.id] || vm.state !== 'stopped')) throw new Error('another workspace became active; refusing host restart')
    const guard = await run(host, `set -e
systemctl is-active --quiet ${lease}
if pgrep -f '^bash .*/images/guest/build-images.sh' >/dev/null; then exit 1; fi`, 30)
    if (!guard.ok) throw new Error('a deployment/image build is active; refusing host restart')
    console.log('All test VMs durably paused; preexisting VMs stopped. Cycling EC2 host.')
    const before = Date.now()
    await ec2.send(new StopInstancesCommand({ InstanceIds: [host] })); stopped = true
    await waitState('stopped')
    await ec2.send(new StartInstancesCommand({ InstanceIds: [host] }))
    await waitState('running'); await waitForSsm(host)
    for (let i = 0; ; i++) { try { await call('GET', '/health'); break } catch (error) { if (i >= 60) throw error; await Bun.sleep(1000) } }
    stopped = false
    await acquireLease()
    results.push({ action: 'host-cycle', totalMs: Date.now() - before }); await save()
    for (const vm of retained) await probe({ action: 'cold', ...vm })
  }
} catch (error) {
  console.error('Benchmark failed:', error instanceof Error ? error.message : error)
  throw error
} finally {
  if (stopped) {
    if (await instanceState(host) === 'stopping') await waitState('stopped')
    if (await instanceState(host) === 'stopped') await ec2.send(new StartInstancesCommand({ InstanceIds: [host] }))
    await waitState('running'); await waitForSsm(host)
  }
  const failures: string[] = []
  for (const id of [...owned].reverse()) {
    try {
      for (let attempt = 0; ; attempt++) {
        try { await call('DELETE', `/vms/${id}`); break }
        catch (error) { if (attempt === 9) throw error; await Bun.sleep(1000) }
      }
      owned.delete(id)
    } catch { failures.push(id) }
  }
  await save()
  const after = await metadata()
  for (const [id, hash] of Object.entries(baseline)) if (after[id] !== hash) failures.push(`existing VM metadata changed: ${id}`)
  await run(host, `systemctl stop ${lease}`, 30).catch(() => {})
  if (failures.length) throw new Error(`cleanup/preservation checks failed: ${failures.join(', ')}`)
  console.log(`Existing metadata unchanged; test VMs removed. Results: ${path}`)
}
