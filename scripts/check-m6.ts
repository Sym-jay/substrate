// M6 host acceptance. Creates and deletes only this run's two VMs; never
// restarts hostd, the EC2 host, or another user's workspace.
import { ExecResult, RunCheckpoint, Session, Vm } from '@substrate/protocol'
import { randomUUID } from 'node:crypto'
import { $ } from 'bun'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { region, run, stackOutputs, upload } from './lib/aws.ts'
import { errorMessage, hostd } from './lib/hostd.ts'

const { HostInstanceId: host, ControlInstanceId: control, ArtifactsBucket: bucket, Url: origin } = await stackOutputs()
const marker = randomUUID()
const owned = new Set<string>()
const check = (label: string, ok: boolean) => { if (!ok) throw new Error(label); console.log(`✓ ${label}`) }
async function call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
  const result = await hostd(host, method, path, body)
  if (result.status >= 400) throw new Error(errorMessage(result))
  return result.data
}
async function exec(id: string, command: string) {
  const result = ExecResult.parse(await call('POST', `/vms/${id}/exec`, { command, timeoutMs: 20_000 }))
  if (result.exitCode !== 0) throw new Error(result.stderr || 'guest command failed')
  return result.stdout.trim()
}
async function probe(id: string, session: Session, phase: 'seed' | 'verify') {
  const source = Buffer.from(await Bun.file(new URL('./lib/m3-terminal-probe.ts', import.meta.url)).text()).toString('base64')
  const path = `/tmp/substrate-m6-probe-${marker}.ts`
  const result = await run(host, ['set -e', 'export PATH="$PATH:/usr/local/bin"',
    `printf %s '${source}' | base64 -d > '${path}'`, `trap 'rm -f ${path}' EXIT`,
    `bun '${path}' '${id}' '${session.id}' '${phase}' '${marker}'`].join('\n'), 30)
  if (!result.ok) throw new Error(result.stderr || 'terminal probe failed')
  return JSON.parse(result.stdout) as { pid: number; memory: boolean; disk: boolean; scrollback: boolean }
}

async function publicAccess(id: string) {
  const dir = await mkdtemp(join(tmpdir(), 'substrate-m6-probe-build-'))
  const key = `control/checks/m6/${marker}/access-probe`
  try {
    await $`bun build --compile --minify --target=bun-linux-arm64 ${join(import.meta.dir, 'lib/m6-access-probe.ts')} --outfile ${join(dir, 'probe')}`.quiet()
    await upload(bucket, key, await Bun.file(join(dir, 'probe')).bytes())
    const remote = `/tmp/substrate-m6-probe-${marker}`
    const result = await run(control, ['set -e', `install -d -m 755 '${remote}'`,
      `trap 'rm -rf ${remote}' EXIT`, `aws s3 cp --quiet 's3://${bucket}/${key}' '${remote}/probe'`, `chmod 755 '${remote}/probe'`,
      'set -a', 'source /etc/substrate/control-secrets.env', 'set +a',
      `runuser --preserve-environment -u substrate -- '${remote}/probe' '${id}' '${origin}'`].join('\n'), 600)
    if (!result.ok) throw new Error(result.stderr || result.stdout || 'public access probe failed')
    console.log('Public access:', result.stdout.trim())
  } finally {
    await new S3Client({ region }).send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    await rm(dir, { recursive: true, force: true })
  }
}

try {
  const sourceId = `vm-${marker.replaceAll('-', '').slice(0, 16)}`
  owned.add(sourceId)
  const vm = Vm.parse(await call('POST', '/vms', { targetId: sourceId, name: `m6-check-${marker.slice(0, 8)}`, size: 'small', diskGib: 16, repository: 'harryfrzz/substrate' }))
  check('small VM boots with a cloned GitHub repository', vm.state === 'running' && !vm.lastError &&
    (await exec(vm.id, 'test -d /home/dev/workspace/.git && echo cloned')) === 'cloned')
  const session = Session.parse(await call('POST', `/vms/${vm.id}/sessions`, {}))
  const original = await probe(vm.id, session, 'seed')
  const grown = Vm.parse(await call('POST', `/vms/${vm.id}/disk`, { diskGib: 18 }))
  check('M7 online disk growth still works before a running-state fork', grown.diskGib === 18 &&
    (await exec(vm.id, 'test $(df --output=size -B1 / | tail -1) -gt 18000000000 && echo grown')) === 'grown')
  const childId = `vm-${randomUUID().replaceAll('-', '').slice(0, 16)}`
  owned.add(childId)
  const child = Vm.parse(await call('POST', `/vms/${vm.id}/fork`, { targetId: childId, name: `m6-fork-${marker.slice(0, 8)}` }))
  const copy = await probe(child.id, session, 'verify')
  const parent = await probe(vm.id, session, 'verify')
  check('fork keeps shell memory, PID, disk and scrollback; original also resumes', copy.pid === original.pid && copy.memory && copy.disk && copy.scrollback && parent.memory)
  check('fork has a separate network identity', child.guestIp !== vm.guestIp && child.parentId === vm.id)
  await call('DELETE', `/vms/${vm.id}`); owned.delete(vm.id)
  check('deleting the parent leaves the fork usable', (await probe(child.id, session, 'verify')).memory)

  // Starting the CLI does not submit a paid agent task. Its session still
  // exercises checkpoint-before-launch and the selected permission mode.
  const agent = Session.parse(await call('POST', `/vms/${child.id}/sessions`, { agent: 'codex', mode: 'ask' }))
  const checkpoints = RunCheckpoint.array().parse(await call('GET', `/vms/${child.id}/checkpoints`))
  const point = checkpoints.find((point) => point.id === agent.checkpointId)
  check('agent launch has a durable rollback point and ask mode', !!point && agent.mode === 'ask' && point.sessionId === agent.id)
  await exec(child.id, 'echo changed > /home/dev/after-checkpoint.txt')
  await call('POST', `/vms/${child.id}/stop`)
  await call('POST', `/vms/${child.id}/checkpoints/${point!.id}/restore`)
  await call('POST', `/vms/${child.id}/resize`, { size: 'medium', diskGib: 20 })
  const resized = Vm.parse(await call('POST', `/vms/${child.id}/start`))
  check('offline resize applies CPU, memory and disk', resized.vcpus === 4 && resized.memMib === 8192 && resized.diskGib === 20)
  check('rollback removed later changes and ext4 grew', (await exec(child.id, 'test ! -e /home/dev/after-checkpoint.txt && test $(df --output=size -B1 / | tail -1) -gt 20000000000 && echo restored')) === 'restored')

  const server = `Bun.serve({hostname:'0.0.0.0',port:3000,fetch(req,server){if(req.headers.get('upgrade')==='websocket'&&server.upgrade(req))return;return Response.json({marker:${JSON.stringify(marker)},path:new URL(req.url).pathname})},websocket:{message(ws,message){ws.send(message)}}})`
  const encoded = Buffer.from(server).toString('base64')
  await exec(child.id, `nohup bun -e 'eval(Buffer.from("${encoded}","base64").toString())' >/tmp/m6-preview.log 2>&1 </dev/null &`)
  await call('POST', `/vms/${child.id}/pause`)
  const preview = await call('GET', `/vms/${child.id}/preview/3000/p/${child.id}/3000/`) as { marker?: string; path?: string }
  check('opening a preview wakes the paused VM and reaches its dev server', preview.marker === marker && preview.path === `/p/${child.id}/3000/`)
  await publicAccess(child.id)
  console.log('Host and public transport checks passed. Private GitHub push/PR and interactive VS Code checks need user credentials; see docs/m6.md.')
} finally {
  for (const id of owned) {
    try {
      const result = await hostd(host, 'DELETE', `/vms/${id}`)
      if (result.status >= 400 && result.status !== 404) throw new Error(errorMessage(result))
      console.log(`cleaned up ${id}`)
    }
    catch (error) { console.error(`Cleanup failed for this check's VM ${id}:`, error); process.exitCode = 1 }
  }
}
