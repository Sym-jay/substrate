import { testDatabase } from '../db.ts'
import { Hono } from 'hono'
import { mkdtemp, mkdir, cp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { StartGuestTask, TaskSpec, type Vm } from '@substrate/protocol'
import { Tasks } from '../../../guestd/src/tasks.ts'
import { createApp } from '../app.ts'
import { Owners } from '../owners.ts'
import { Jobs } from '../jobs.ts'
import { Tickets } from '../tickets.ts'
import { Workflows, WorkflowStore } from '../workflows.ts'
import { CliCredentials, withCliAuthentication } from '../cli-auth.ts'
import { cliRoutes } from '../cli-routes.ts'

export async function fixture(options: { webDir?: string; browserUser?: string; port?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'substrate-cli-fixture-'))
  const db = await testDatabase()
  const owners = new Owners(db), jobs = new Jobs(db)
  const credentials = new CliCredentials(db), store = new WorkflowStore(db)
  const records = new Map<string, Vm>(), guests = new Map<string, Tasks>(), folders = new Map<string, string>(), calls: string[] = []
  const add = async (id: string, name: string, source?: string) => {
    const cwd = join(directory, id); await mkdir(cwd, { recursive: true })
    if (source) await cp(folders.get(source)!, cwd, { recursive: true })
    const engine = new Tasks({ directory: join(directory, id + '-tasks'), cwd, argv: (command) => ['/bin/bash', '-c', command] })
    await engine.start(); guests.set(id, engine); folders.set(id, cwd)
    const vm: Vm = { id, name, state: 'running', vcpus: 2, memMib: 4096, diskGib: 8, image: 'local-fixture', guestIp: '172.30.0.2', createdAt: new Date().toISOString(), startedAt: null, bootMs: 1, lastError: null }
    records.set(id, vm); return vm
  }
  await add('vm-alice', 'demo'); await owners.add('vm-alice', 'alice')
  await add('vm-bob', 'private'); await owners.add('vm-bob', 'bob')
  await writeFile(join(folders.get('vm-alice')!, 'seed'), 'same seed')
  const host = new Hono()
  host.use('*', async (c, next) => { calls.push(`${c.req.method} ${c.req.path}`); await next() })
  host.get('/vms', (c) => c.json([...records.values()]))
  host.post('/vms', async (c) => { const body = await c.req.json(); return c.json(await add(body.targetId, body.name ?? 'new-workspace'), 201) })
  host.get('/vms/:id', (c) => records.has(c.req.param('id')) ? c.json(records.get(c.req.param('id'))) : c.json({ error: 'not found' }, 404))
  host.delete('/vms/:id', async (c) => { records.delete(c.req.param('id')); await guests.get(c.req.param('id'))?.close(); return c.body(null, 204) })
  host.post('/vms/:id/fork', async (c) => { const body = await c.req.json(); return c.json(await add(body.targetId, body.name ?? 'fork', c.req.param('id')), 201) })
  host.post('/vms/:id/forks', async (c) => { const body = await c.req.json(); const vms = []; for (const child of body.children) vms.push(await add(child.id, child.name, c.req.param('id'))); return c.json({ vms, checkpointId: randomUUID() }, 201) })
  host.post('/vms/:id/exec', async (c) => {
    const { command } = await c.req.json(); const child = Bun.spawn(['/bin/bash', '-lc', command], { cwd: folders.get(c.req.param('id')), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    return c.json({ exitCode: await child.exited, stdout, stderr, durationMs: 1, timedOut: false })
  })
  host.get('/vms/:id/tasks/:task', (c) => { const task = guests.get(c.req.param('id'))?.get(c.req.param('task')); return task ? c.json(task) : c.json({ error: 'missing task' }, 404) })
  host.post('/vms/:id/tasks', async (c) => c.json(await guests.get(c.req.param('id'))!.create(StartGuestTask.parse(await c.req.json())), 201))
  host.post('/vms/:id/tasks/:task/cancel', async (c) => c.json(await guests.get(c.req.param('id'))!.cancel(c.req.param('task'), (await c.req.json()).spec)))
  host.patch('/vms/:id', async (c) => { const vm = records.get(c.req.param('id'))!; Object.assign(vm, await c.req.json()); return c.json(vm) })
  host.post('/vms/:id/:action', (c) => {
    const vm = records.get(c.req.param('id'))!, action = c.req.param('action')
    vm.state = action === 'pause' ? 'paused' : action === 'stop' ? 'stopped' : 'running'; return c.json(vm)
  })
  const hostServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: host.fetch })
  const disabled = new Set<string>()
  const browser = async (req: Request) => {
    const value = req.headers.get('authorization')?.slice(7) ?? options.browserUser
    return value && ['alice', 'bob'].includes(value) ? { id: value } : null
  }
  const authenticate = withCliAuthentication(browser, credentials, async (id) => !disabled.has(id))
  const workflows = new Workflows({ store, owners, jobs, maxVmsPerUser: 8, hostd: { url: `http://127.0.0.1:${hostServer.port}`, token: 'fixture' } }); const workflowTimer = workflows.start()
  const app = createApp({ version: 'cli-fixture', region: 'local', webDir: options.webDir ?? 'missing', readHost: async () => ({ configured: false }), clerkPublishableKey: null,
    cli: cliRoutes({ credentials, browserAuthenticate: browser, authenticate, requireBrowserBearer: !options.browserUser }),
    vms: { owners, jobs, workflows, authenticate, tickets: new Tickets(), maxVmsPerUser: 8, hostd: { url: `http://127.0.0.1:${hostServer.port}`, token: 'fixture' } } })
  const server = Bun.serve({ hostname: '127.0.0.1', port: options.port ?? 0, fetch: app.fetch })
  const token = async (user: 'alice' | 'bob', name = 'CLI test') => { const grant = (await credentials.begin(name)); (await credentials.decide(grant.userCode, user, true)); return (await credentials.poll(grant.deviceCode))! }
  return { directory, credentials, token, disabled, calls, app, workflows, records, folders, url: `http://127.0.0.1:${server.port}`,
    async close() { server.stop(true); hostServer.stop(true); clearInterval(workflowTimer); for (const guest of guests.values()) await guest.close(); await db.close(); await rm(directory, { recursive: true, force: true }) } }
}
