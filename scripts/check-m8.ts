// M8 acceptance on AWS. Uses three default VMs owned only by this run. Does
// not stop the host or touch another user's VM. Needs ~48 GiB unreserved RAM.
import { ExecResult, Vm, type VmMemory } from '@substrate/protocol'
import { randomUUID } from 'node:crypto'
import { run, stackOutputs } from './lib/aws.ts'
import { errorMessage, hostd } from './lib/hostd.ts'

const { HostInstanceId: host } = await stackOutputs()
const marker = randomUUID(), owned = new Set<string>()
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) throw new Error(label + (detail ? ': ' + detail : ''))
  console.log(`✓ ${label}${detail ? ': ' + detail : ''}`)
}
async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) {
  const response = await hostd(host, method, path, body)
  if (response.status >= 400) throw new Error(errorMessage(response))
  return response.data
}
async function exec(id: string, command: string) {
  const result = ExecResult.parse(await call('POST', `/vms/${id}/exec`, { command, timeoutMs: 20_000 }))
  if (result.exitCode !== 0) throw new Error(result.stderr || 'test guest command failed')
  return result.stdout.trim()
}
async function list() { return Vm.array().parse(await call('GET', '/vms')).filter((vm) => owned.has(vm.id)) }
async function until(label: string, done: (vms: Vm[]) => boolean, timeoutMs = 120_000) {
  const started = Date.now()
  for (;;) {
    const vms = await list()
    if (done(vms)) return vms
    if (Date.now() - started > timeoutMs) throw new Error(`${label} timed out: ${JSON.stringify(vms.map(({ name, state, memory }) => ({ name, state, memory })))}`)
    await Bun.sleep(1000)
  }
}
const memory = (vm: Vm) => vm.memory as VmMemory
const settled = (vm: Vm) => vm.state === 'running' && vm.memory?.actualMib != null && vm.memory.sampledAt != null &&
  Date.now() - Date.parse(vm.memory.sampledAt) < 8000

try {
  const ids: string[] = []
  for (let index = 0; index < 3; index++) {
    const id = `vm-${randomUUID().replaceAll('-', '').slice(0, 16)}`
    owned.add(id); ids.push(id)
    const vm = Vm.parse(await call('POST', '/vms', { targetId: id, name: `m8-${marker.slice(0, 8)}-${index}`, diskGib: 8 }))
    check(`default VM ${index + 1} boots`, vm.state === 'running' && vm.memMib === 16_384, `${vm.bootMs} ms`)
    await call('PATCH', `/vms/${id}`, { autoPauseMinutes: null })
  }
  let vms = await until('three 4 GiB allocations', (vms) => vms.length === 3 && vms.every((vm) => settled(vm) && memory(vm).targetMib === 4096 && memory(vm).actualMib! <= 4352))
  const resident = () => vms.reduce((sum, vm) => sum + (memory(vm).residentMib ?? Infinity), 0)
  check('three idle default VMs together use less than 16 GiB host RSS', resident() < 16_384, `${Math.round(resident())} MiB`)
  console.log('Initial memory:', JSON.stringify(vms.map(({ name, memory }) => ({ name, memory }))))

  const id = ids[0]!
  const source = `import json,os,time
chunks=[]
for i in range(96):
    chunks.append(bytearray(bytes([i%251+1])*(128*1024*1024)))
    time.sleep(0.4)
tick=0
while True:
    ok=all(chunk[0]==i%251+1 and chunk[-1]==i%251+1 for i,chunk in enumerate(chunks))
    tick+=1
    with open('/home/dev/m8-pressure.json','w') as f:
        json.dump({'pid':os.getpid(),'tick':tick,'ok':ok,'allocatedMib':12288},f)
    time.sleep(1)
`
  const encoded = Buffer.from(source).toString('base64')
  await exec(id, `printf %s '${encoded}' | base64 -d > /home/dev/m8-pressure.py; nohup python3 /home/dev/m8-pressure.py >/home/dev/m8-pressure.log 2>&1 </dev/null &`)
  vms = await until('growth to the configured ceiling', (vms) => vms.some((vm) => vm.id === id && settled(vm) && memory(vm).targetMib === 16_384 && memory(vm).actualMib! >= 16_128), 150_000)
  check('memory pressure grows a 4 GiB VM to its 16 GiB limit', true, JSON.stringify(memory(vms.find((vm) => vm.id === id)!)))
  const readyDeadline = Date.now() + 60_000
  while (await exec(id, 'test -s /home/dev/m8-pressure.json && echo ready || echo waiting') !== 'ready') {
    if (Date.now() > readyDeadline) throw new Error('pressure workload did not finish allocating')
    await Bun.sleep(1000)
  }
  const state = async () => JSON.parse(await exec(id, 'cat /home/dev/m8-pressure.json')) as { pid: number; tick: number; ok: boolean }
  const before = await state()
  check('12 GiB workload retains its data without an OOM kill', before.ok)
  await call('POST', `/vms/${id}/pause`)
  const resumed = Vm.parse(await call('POST', `/vms/${id}/resume`))
  const after = await state()
  check('ballooned VM preserves the same process and data across pause/resume', after.pid === before.pid && after.ok, `${resumed.resumeMs} ms resume`)
  await Bun.sleep(1500)
  check('the restored process keeps running', (await state()).tick > after.tick)
  await exec(id, `kill -TERM ${after.pid}`)
  const released = Date.now()
  vms = await until('reclaiming released RAM', (vms) => vms.length === 3 && vms.every((vm) => settled(vm) && memory(vm).targetMib === 4096 && memory(vm).actualMib! <= 4352), 150_000)
  check('released memory returns to the 4 GiB floor', true, `${Math.round((Date.now() - released) / 1000)} s`)
  check('three idle VMs remain below 16 GiB host RSS after pressure', resident() < 16_384, `${Math.round(resident())} MiB`)

  // The controller must rediscover devices and use their actual targets when
  // hostd restarts; VM processes stay in their own units.
  const all = Vm.array().parse(await call('GET', '/vms'))
  if (all.some((vm) => !owned.has(vm.id) && vm.state !== 'stopped' && vm.state !== 'paused')) {
    console.log('Skipped hostd-restart probe: another workspace is active.')
  } else {
    const restarted = await run(host, 'systemctl restart substrate-hostd', 30)
    check('hostd restart succeeds without stopping the test VMs', restarted.ok)
    await Bun.sleep(2000)
    vms = await until('memory telemetry after hostd restart', (vms) => vms.length === 3 && vms.every(settled))
    check('memory management resumes after hostd restarts', vms.every((vm) => memory(vm).limitMib === 16_384))
  }
} finally {
  for (const id of owned) {
    try {
      const response = await hostd(host, 'DELETE', `/vms/${id}`)
      if (response.status >= 400 && response.status !== 404) throw new Error(errorMessage(response))
      console.log(`cleaned up ${id}`)
    } catch (error) { console.error('test VM cleanup failed:', error); process.exitCode = 1 }
  }
}
