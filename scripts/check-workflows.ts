// Real AWS acceptance after deploying host/control and rebuilding the guest
// image. Own small VMs only; no shared-host restart and no model/API charges.
import { randomUUID } from 'node:crypto'
import { GuestTask, TaskSpec, Vm, taskIsActive } from '@substrate/protocol'
import { stackOutputs } from './lib/aws.ts'
import { errorMessage, hostd } from './lib/hostd.ts'

const { HostInstanceId: host } = await stackOutputs()
const marker = randomUUID().slice(0, 8)
const owned = new Set<string>()
const id = () => `vm-${randomUUID().replaceAll('-', '').slice(0, 16)}`
const check = (label: string, ok: boolean, detail = '') => { if (!ok) throw new Error(`${label}: ${detail}`); console.log(`✓ ${label}${detail ? ': ' + detail : ''}`) }
async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) {
  const response = await hostd(host, method, path, body)
  if (response.status >= 400) throw new Error(errorMessage(response))
  return response.data
}
async function execute(vmId: string, command: string, user: 'dev' | 'root' = 'dev') {
  const result = await call('POST', `/vms/${vmId}/exec`, { command, user, timeoutMs: 20_000 }) as { exitCode: number; stdout: string; stderr: string }
  if (result.exitCode !== 0) throw new Error(result.stderr || 'guest command failed')
  return result.stdout.trim()
}
async function submit(vmId: string, input: string, verificationCommand = '') {
  const taskId = randomUUID()
  const spec = TaskSpec.parse({ title: `Acceptance ${marker}`, runner: 'command', input, verificationCommand, timeoutSeconds: 180 })
  return GuestTask.parse(await call('POST', `/vms/${vmId}/tasks`, { id: taskId, spec }))
}
async function result(vmId: string, taskId: string) {
  const deadline = Date.now() + 180_000
  for (;;) {
    if (Date.now() > deadline) throw new Error('task result timed out')
    const response = await hostd(host, 'GET', `/vms/${vmId}/tasks/${taskId}`)
    if ([409, 502, 503].includes(response.status)) { await Bun.sleep(1000); continue }
    if (response.status >= 400) throw new Error(errorMessage(response))
    const run = GuestTask.parse(response.data)
    if (!taskIsActive(run.state)) return run
    await Bun.sleep(1000)
  }
}

try {
  const sourceId = id(); owned.add(sourceId)
  const source = Vm.parse(await call('POST', '/vms', { targetId: sourceId, name: `wf-${marker}-source`, size: 'small', diskGib: 8 }))
  check('source workspace boots', source.state === 'running', `${source.bootMs} ms`)
  await execute(sourceId, `mkdir -p /home/dev/workspace; printf '%s' '${marker}' > /home/dev/workspace/comparison-seed`)
  const first = await submit(sourceId, `printf 'task-${marker}'`, "printf 'verification passed'")
  const completed = await result(sourceId, first.id)
  check('guest task output and verification persist', completed.state === 'succeeded' && completed.result === `task-${marker}` && completed.verification?.exitCode === 0)

  const children = [id(), id()] as const
  for (const child of children) owned.add(child)
  const pair = await call('POST', `/vms/${sourceId}/forks`, { children: children.map((child, index) => ({ id: child, name: `wf-${marker}-${index ? 'b' : 'a'}` })) }) as { vms: unknown; checkpointId: string }
  const forks = Vm.array().parse(pair.vms)
  check('two running forks confirm a common generation', forks.length === 2 && forks.every((vm) => vm.state === 'running') && !!pair.checkpointId, pair.checkpointId)
  const runs = await Promise.all(children.map((child, index) => submit(child, `printf '${index ? 'beta' : 'alpha'}' > approach-result; cat comparison-seed`, 'test -s approach-result')))
  const outputs = await Promise.all(children.map((child, index) => result(child, runs[index]!.id)))
  check('both approaches see the original seed', outputs.every((run) => run.state === 'succeeded' && run.result === marker && run.verification?.exitCode === 0))
  check('fork disks diverge independently', await execute(children[0], 'cat /home/dev/workspace/approach-result') === 'alpha' && await execute(children[1], 'cat /home/dev/workspace/approach-result') === 'beta')
  check('source disk remains independent', await execute(sourceId, 'test ! -e /home/dev/workspace/approach-result && printf untouched') === 'untouched')

  const pausedTask = await submit(children[0], "printf 'before pause\n'; sleep 25; printf 'after resume'")
  await call('POST', `/vms/${children[0]}/pause`)
  const resumed = Vm.parse(await call('POST', `/vms/${children[0]}/resume`))
  const resumedResult = await result(children[0], pausedTask.id)
  check('a live task survives full VM pause/resume', resumedResult.state === 'succeeded' && resumedResult.stdout.includes('before pause') && resumedResult.stdout.includes('after resume'), `${resumed.resumeMs} ms resume`)

  const cancelled = await submit(children[1], "printf 'cancellation started'; (sleep 20; printf leaked > /home/dev/workspace/cancelled-child) & wait")
  await Bun.sleep(250)
  const cancellationStarted = Date.now()
  const stopped = GuestTask.parse(await call('POST', `/vms/${children[1]}/tasks/${cancelled.id}/cancel`, { spec: cancelled.spec }))
  check('cancellation ends the active task promptly', stopped.state === 'cancelled' && Date.now() - cancellationStarted < 10_000)
  await Bun.sleep(20500)
  check('cancellation kills background children too', await execute(children[1], 'test ! -e /home/dev/workspace/cancelled-child && printf safe') === 'safe')

  const interrupted = await submit(children[1], 'sleep 120; printf should-not-replay >> /home/dev/workspace/replayed')
  await execute(children[1], "nohup sh -c 'sleep 1; systemctl restart substrate-guestd' >/tmp/workflow-restart.log 2>&1 </dev/null &", 'root')
  await Bun.sleep(2000)
  const recovered = await result(children[1], interrupted.id)
  check('guest restart reports interruption without replaying', recovered.state === 'interrupted' && await execute(children[1], 'test ! -e /home/dev/workspace/replayed && printf safe') === 'safe')
  console.log('Workflow AWS acceptance passed. Agent-provider login and public UI checks are separate.')
} finally {
  for (const vmId of owned) {
    try {
      const response = await hostd(host, 'DELETE', `/vms/${vmId}`)
      if (response.status !== 204 && response.status !== 404) throw new Error(errorMessage(response))
    } catch (error) { console.error(`Cleanup failed for owned test workspace ${vmId}:`, error) }
  }
}
