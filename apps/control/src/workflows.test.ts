import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { TaskSpec, type Task, type Vm, type Comparison } from '@substrate/protocol'
import { Tasks as GuestTasks } from '../../guestd/src/tasks.ts'
import { createApp } from './app.ts'
import { Owners } from './owners.ts'
import { Jobs } from './jobs.ts'
import { Tickets } from './tickets.ts'
import { Workflows, WorkflowStore } from './workflows.ts'
import { testDatabase } from './db.ts'

const cleanups: (() => Promise<void>)[] = []
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup() })
const makeSpec = (input: string, verificationCommand = '') => TaskSpec.parse({ title: 'Real task', runner: 'command', input, verificationCommand })
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
async function eventually<T>(read: () => T | Promise<T>, ready: (value: T) => boolean) {
  for (let i = 0; i < 300; i++) { const value = await read(); if (ready(value)) return value; await Bun.sleep(10) }
  throw new Error('condition did not become true')
}
async function rig() {
  const directory = await mkdtemp(join(tmpdir(), 'substrate-workflows-'))
  const db = await testDatabase()
  const owner = new Owners(db), jobs = new Jobs(db), store = new WorkflowStore(join(directory, 'control.db'))
  const records = new Map<string, Vm>(), guests = new Map<string, GuestTasks>(), folders = new Map<string, string>()
  const calls: string[] = []
  let forks = 0, failFork = false, loseStart = false, loseReads = false
  const checkpointId = crypto.randomUUID()
  const addVm = async (id: string, from?: string) => {
    const folder = join(directory, id)
    await mkdir(folder, { recursive: true })
    if (from) await cp(folders.get(from)!, folder, { recursive: true })
    const guest = new GuestTasks({ directory: join(directory, `${id}-task-records`), cwd: folder, argv: (command) => ['/bin/bash', '-c', command] })
    await guest.start(); guests.set(id, guest); folders.set(id, folder)
    const vm: Vm = { id, name: id, state: 'running', vcpus: 2, memMib: 4096, diskGib: 8, image: 'test', guestIp: '172.30.0.2', createdAt: new Date().toISOString(), startedAt: null, bootMs: 1, lastError: null }
    records.set(id, vm)
    return vm
  }
  await addVm('vm-source'); await owner.add('vm-source', 'alice')
  await writeFile(join(folders.get('vm-source')!, 'seed'), 'same starting state')
  const host = new Hono()
  host.use('*', async (c, next) => { if (c.req.header('authorization') !== 'Bearer host-token') return c.json({ error: 'no' }, 401); calls.push(`${c.req.method} ${c.req.path}`); await next() })
  host.get('/vms', (c) => c.json([...records.values()]))
  host.get('/vms/:id', (c) => records.has(c.req.param('id')) ? c.json(records.get(c.req.param('id'))) : c.json({ error: 'missing' }, 404))
  host.get('/vms/:id/tasks/:task', (c) => {
    if (loseReads) return c.json({ error: 'temporary read outage' }, 502)
    const run = guests.get(c.req.param('id'))?.get(c.req.param('task'))
    return run ? c.json(run) : c.json({ error: 'task missing' }, 404)
  })
  host.post('/vms/:id/tasks', async (c) => {
    const run = await guests.get(c.req.param('id'))!.create(await c.req.json())
    if (loseStart) return c.json({ error: 'response lost after starting' }, 502)
    return c.json(run, 201)
  })
  host.post('/vms/:id/tasks/:task/cancel', async (c) => c.json(await guests.get(c.req.param('id'))!.cancel(c.req.param('task'), (await c.req.json()).spec)))
  host.post('/vms/:id/forks', async (c) => {
    forks++
    await Bun.sleep(50)
    if (failFork) return c.json({ error: 'not enough storage for comparison forks' }, 409)
    const body = await c.req.json() as { children: { id: string }[] }
    const vms = []
    for (const child of body.children) vms.push(await addVm(child.id, c.req.param('id')))
    return c.json({ vms, checkpointId }, 201)
  })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: host.fetch })
  const options = { store, owners: owner, jobs, maxVmsPerUser: 3, hostd: { url: `http://127.0.0.1:${server.port}`, token: 'host-token' } }
  const workflows = new Workflows(options)
  const app = createApp({ version: 'test', region: 'test', webDir: 'missing', clerkPublishableKey: null,
    readHost: async () => ({ configured: false }), vms: { ...options, authenticate: async (req) => req.headers.get('x-user') ? { id: req.headers.get('x-user')! } : null, tickets: new Tickets(), workflows } })
  const call = (user: string | null, path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { ...init.headers, ...(user ? { 'x-user': user } : {}) } })
  cleanups.push(async () => { server.stop(true); for (const guest of guests.values()) await guest.close(); store.close(); await rm(directory, { recursive: true, force: true }) })
  return { directory, workflows, store, options, call, records, folders, guests, calls, checkpointId, get forks() { return forks }, failFork: () => { failFork = true }, loseResponses: () => { loseStart = loseReads = true }, restoreReads: () => { loseReads = false } }
}

test('task endpoints enforce authentication and owner isolation, including output and review', async () => {
  const r = await rig()
  for (const path of ['/api/tasks', '/api/comparisons']) expect((await r.call(null, path)).status).toBe(401)
  expect((await r.call('bob', '/api/tasks', post({ vmId: 'vm-source', spec: makeSpec('printf private') }))).status).toBe(404)
  const created = await r.call('alice', '/api/tasks', post({ vmId: 'vm-source', spec: makeSpec('printf private-output', 'printf tested') }))
  expect(created.status).toBe(202)
  const task = await created.json() as Task
  await eventually(async () => { await r.workflows.refresh('alice'); return r.workflows.task('alice', task.id) }, (task) => task.run?.state === 'succeeded')
  expect((await r.call('bob', `/api/tasks/${task.id}`)).status).toBe(404)
  expect((await r.call('bob', `/api/tasks/${task.id}`, { ...post({ reviewed: true }), method: 'PATCH' })).status).toBe(404)
  expect((await r.call('bob', `/api/tasks/${task.id}/cancel`, post({}))).status).toBe(404)
  expect(await (await r.call('bob', '/api/tasks')).json()).toEqual([])
  const detail = await (await r.call('alice', `/api/tasks/${task.id}`)).json() as Task
  expect(detail.run?.result).toBe('private-output')
  expect(detail.run?.verification?.output).toBe('tested')
  const summary = r.workflows.list('alice').find((item) => item.id === task.id)!
  expect(summary.run?.stdout).toBe('')
  expect(summary.run?.verification?.output).toBe('')
  expect(summary.run?.result).toBe('private-output')
  const reviewed = await r.call('alice', `/api/tasks/${task.id}`, { ...post({ reviewed: true }), method: 'PATCH' })
  expect((await reviewed.json() as Task).reviewedAt).not.toBeNull()
  const ticket = await r.call('alice', '/api/vms/vm-source/sessions/session/terminal/ticket', post({}))
  expect(ticket.status).toBe(200) // Workflow middleware must not intercept terminal auth.
  const preview = await r.call('alice', '/api/tasks', { headers: { 'x-substrate-preview': '1' } })
  expect(preview.status).toBe(404)
})

test('comparisons reserve both quota places, request one fork generation, and run isolated commands', async () => {
  const r = await rig()
  const input = { sourceVmId: 'vm-source', title: 'Two approaches', approaches: [
    makeSpec('printf alpha > result; cat seed', 'test "$(cat result)" = alpha'),
    makeSpec('printf beta > result; cat seed', 'test "$(cat result)" = alpha'),
  ] }
  const responses = await Promise.all([r.call('alice', '/api/comparisons', post(input)), r.call('alice', '/api/comparisons', post(input))])
  expect(responses.map((response) => response.status).sort()).toEqual([202, 409])
  const comparison = await responses.find((response) => response.status === 202)!.json() as Comparison
  expect(r.workflows.pendingVms('alice')).toHaveLength(2)
  expect((await r.call('alice', '/api/vms', post({ name: 'racing-create' }))).status).toBe(409)
  const ready = await eventually(async () => { await r.workflows.refresh('alice'); return r.workflows.comparison('alice', comparison.id) }, (item) => item.state === 'ready')
  expect(r.forks).toBe(1)
  expect(ready.sourceCheckpointId).toBe(r.checkpointId)
  const tasks = await eventually(async () => { await r.workflows.refresh('alice'); return comparison.taskIds.map((id) => r.workflows.task('alice', id)) }, (tasks) => tasks.every((task) => !!task.run?.finishedAt))
  expect(tasks.map((task) => task.run?.stdout)).toEqual(['same starting state', 'same starting state'])
  expect(tasks.map((task) => task.run?.state)).toEqual(['succeeded', 'failed'])
  expect(await readFile(join(r.folders.get(comparison.vmIds[0])!, 'result'), 'utf8')).toBe('alpha')
  expect(await readFile(join(r.folders.get(comparison.vmIds[1])!, 'result'), 'utf8')).toBe('beta')
  expect(await Bun.file(join(r.folders.get('vm-source')!, 'result')).exists()).toBe(false)
  expect((await r.call('bob', `/api/comparisons/${comparison.id}`)).status).toBe(404)
  expect((await r.call('alice', `/api/comparisons/${comparison.id}/select`, post({ taskId: crypto.randomUUID() }))).status).toBe(400)
  expect((await r.call('alice', `/api/comparisons/${comparison.id}/select`, post({ taskId: tasks[0]!.id }))).status).toBe(200)
  expect(r.workflows.comparison('alice', comparison.id).selectedTaskId).toBe(tasks[0]!.id)
  expect(r.records.size).toBe(3) // Choosing never deletes the other approach.
  const recoveredStore = new WorkflowStore(join(r.directory, 'control.db'))
  expect(recoveredStore.comparison('alice', comparison.id)?.selectedTaskId).toBe(tasks[0]!.id)
  expect(recoveredStore.task('alice', tasks[0]!.id)?.run?.result).toBe('same starting state')
  expect(recoveredStore.comparisons('bob')).toEqual([])
  recoveredStore.close()
})

test('preparation failures are retained for review and do not dispatch either task', async () => {
  const r = await rig(); r.failFork()
  const comparison = await (await r.call('alice', '/api/comparisons', post({ sourceVmId: 'vm-source', title: 'Storage failure', approaches: [makeSpec('printf a'), makeSpec('printf b')] }))).json() as Comparison
  const failed = await eventually(() => r.workflows.comparison('alice', comparison.id), (item) => item.state === 'failed')
  expect(failed.error).toContain('not enough storage')
  expect(r.calls.filter((path) => /^POST \/vms\/[^/]+\/tasks$/.test(path))).toEqual([])
  expect(r.workflows.pendingVms('alice')).toEqual([])
  expect(comparison.taskIds.map((id) => r.workflows.task('alice', id).error)).toEqual([
    'The comparison was not prepared. Inspect its workspaces before retrying.', 'The comparison was not prepared. Inspect its workspaces before retrying.',
  ])
})

test('a new control service reconciles ongoing guest work without replaying it, and GET does not wake a paused VM', async () => {
  const r = await rig()
  const created = await r.workflows.createTask('alice', 'vm-source', makeSpec('sleep 0.2; printf survived'))
  await eventually(() => r.workflows.task('alice', created.id), (task) => !!task.run)
  const recovered = new Workflows(r.options)
  const starts = r.calls.filter((path) => path === 'POST /vms/vm-source/tasks').length
  r.records.get('vm-source')!.state = 'paused'
  const calls = r.calls.length
  await recovered.refresh('alice')
  expect(r.calls.slice(calls)).toEqual(['GET /vms'])
  r.records.get('vm-source')!.state = 'running'
  const result = await eventually(async () => { await recovered.refresh('alice'); return recovered.task('alice', created.id) }, (task) => task.run?.state === 'succeeded')
  expect(result.run?.result).toBe('survived')
  expect(r.calls.filter((path) => path === 'POST /vms/vm-source/tasks')).toHaveLength(starts)
  const database = new WorkflowStore(':memory:')
  const saved = r.store.task('alice', created.id)!
  database.saveTask('alice', saved)
  expect(database.task('bob', saved.id)).toBeNull()
  database.close()
})

test('uncertain dispatch blocks duplicate work and recovers by reading the same ID', async () => {
  const r = await rig(); r.loseResponses()
  const task = await r.workflows.createTask('alice', 'vm-source', makeSpec('sleep .15; printf once >> counter; cat counter'))
  await eventually(() => r.workflows.task('alice', task.id), (task) => task.dispatchUncertain)
  expect(r.workflows.hasActiveTask('alice', 'vm-source')).toBe(true)
  expect((await r.call('alice', '/api/tasks', post({ vmId: 'vm-source', spec: makeSpec('printf duplicated') }))).status).toBe(409)
  r.restoreReads()
  const result = await eventually(async () => { await r.workflows.refresh('alice'); return r.workflows.task('alice', task.id) }, (task) => task.run?.state === 'succeeded')
  expect(result.dispatchUncertain).toBe(false)
  expect(result.error).toBeNull()
  expect(result.run?.result).toBe('once')
  expect(r.calls.filter((call) => call === 'POST /vms/vm-source/tasks')).toHaveLength(1)
})

test('a stopped workspace interrupts known work without claiming preparation never completed', async () => {
  const r = await rig()
  const task = await r.workflows.createTask('alice', 'vm-source', makeSpec('printf started; sleep 1'))
  await eventually(() => r.workflows.task('alice', task.id), (task) => !!task.run?.startedAt)
  await r.guests.get('vm-source')!.cancel(task.id)
  r.records.get('vm-source')!.state = 'stopped'
  await r.workflows.refresh('alice')
  const interrupted = r.workflows.task('alice', task.id)
  expect(interrupted.run?.state).toBe('interrupted')
  expect(interrupted.error).toBeNull()
  expect(interrupted.run?.error).toContain('stopped')
})
