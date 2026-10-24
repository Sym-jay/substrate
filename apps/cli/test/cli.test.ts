import { afterAll, expect, test } from 'bun:test'
import { readFile, stat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Task, type Comparison } from '@substrate/protocol'
import { fixture } from '../../control/src/testing/cli-fixture.ts'
import { Client } from '../src/client.ts'
import { connection, serverOrigin, writeConfig } from '../src/config.ts'

const cleanups: (() => Promise<void>)[] = []
afterAll(async () => { for (const clean of cleanups.reverse()) await clean() })
const entry = join(import.meta.dir, '../src/index.ts')
async function rig() {
  const api = await fixture(); cleanups.push(() => api.close())
  const configDir = join(api.directory, 'config')
  const env = { PATH: process.env.PATH, SUBSTRATE_CONFIG_DIR: configDir }
  const spawn = (args: string[], input?: string) => Bun.spawn([process.execPath, entry, ...args], { env, stdin: input === undefined ? 'ignore' : new Blob([input]), stdout: 'pipe', stderr: 'pipe' })
  const invoke = async (args: string[], input?: string) => {
    const process = spawn(args, input)
    const [stdout, stderr] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text()])
    return { code: await process.exited, stdout, stderr, json: () => JSON.parse(stdout) }
  }
  const importLogin = async (user: 'alice' | 'bob' = 'alice') => { const grant = (await api.token(user)); const result = await invoke(['login', '--url', api.url, '--token-stdin', '--json'], grant.token); expect(result.code).toBe(0); return grant }
  return { ...api, configDir, env, spawn, invoke, importLogin }
}
async function until(read: () => boolean, limit = 5000) { const end = Date.now() + limit; while (!read()) { if (Date.now() > end) throw new Error('condition timed out'); await Bun.sleep(10) } }

// Real CLI processes and HTTP control routes; guest commands run in isolated
// local directories. The host/Firecracker layer is simulated, never AWS.
test('browser login completes only after approval and saves an origin-bound private credential', async () => {
  const r = await rig(), process = r.spawn(['login', '--url', r.url, '--no-browser', '--name', 'Integration laptop', '--json'])
  let stderr = ''
  const stderrDone = (async () => { for await (const chunk of process.stderr) stderr += new TextDecoder().decode(chunk) })()
  await until(() => /cli\/([A-Z2-9]{4}-[A-Z2-9]{4})/.test(stderr))
  const code = /cli\/([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(stderr)![1]!
  expect((await r.credentials.list('alice'))).toHaveLength(0)
  const approved = await fetch(r.url + '/api/cli/device/' + code + '/approve', { method: 'POST', headers: { authorization: 'Bearer alice' } })
  expect(approved.status).toBe(204)
  const stdout = await new Response(process.stdout).text(); expect(await process.exited).toBe(0); await stderrDone
  expect(JSON.parse(stdout).server).toBe(r.url)
  const path = join(r.configDir, 'credentials.json'), contents = JSON.parse(await readFile(path, 'utf8'))
  const token = contents.servers[r.url].token
  expect(stdout.includes(token)).toBe(false); expect(stderr.includes(token)).toBe(false)
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect((await stat(r.configDir)).mode & 0o777).toBe(0o700)
  const list = await r.invoke(['workspace', 'list', '--json'])
  expect(list.code).toBe(0); expect(list.json().map((vm: { id: string }) => vm.id)).toEqual(['vm-alice'])
  const other = await connection('http://127.0.0.1:1', r.env)
  expect(other.token).toBeUndefined()
  const foreign = await r.invoke(['workspace', 'get', 'vm-bob', '--json'])
  expect(foreign.code).toBe(1); expect(foreign.stderr).not.toContain('private')
}, 15_000)

test('workspace lifecycle and literal exec arguments work, and deletion requires --yes', async () => {
  const r = await rig(); await r.importLogin()
  const created = await r.invoke(['workspace', 'create', '--name', 'cli-demo', '--size', 'small', '--disk', '8', '--json'])
  expect(created.code).toBe(0); const vm = created.json(); expect(vm.name).toBe('cli-demo')
  expect((await r.invoke(['workspace', 'pause', vm.id, '--json'])).json().state).toBe('paused')
  expect((await r.invoke(['workspace', 'resume', vm.id, '--json'])).json().state).toBe('running')
  const literal = "$(touch injected) 'quoted' ; echo unsafe"
  const exec = await r.invoke(['workspace', 'exec', vm.id, '--json', '--', 'printf', '%s', literal])
  expect(exec.code).toBe(0); expect(exec.json().stdout).toBe(literal)
  expect(await Bun.file(join(r.folders.get(vm.id)!, 'injected')).exists()).toBe(false)
  const failure = await r.invoke(['workspace', 'exec', vm.id, '--command', 'printf output; printf error >&2; exit 7'])
  expect(failure.code).toBe(7); expect(failure.stdout).toBe('output'); expect(failure.stderr).toBe('error')
  expect((await r.invoke(['workspace', 'settings', vm.id, '--idle', 'off', '--max-run', '12', '--json'])).json().autoPauseMinutes).toBeNull()
  const before = r.calls.length
  expect((await r.invoke(['workspace', 'delete', vm.id])).code).toBe(2)
  expect(r.calls.length).toBe(before)
  expect((await r.invoke(['workspace', 'delete', vm.id, '--yes', '--json'])).code).toBe(0)
  expect(r.records.has(vm.id)).toBe(false)
  expect((await r.invoke(['workspace', 'create', '--size', 'bogus', '--json'])).code).not.toBe(0)
  expect((await r.invoke(['workspace', 'list', '--szie', 'small', '--json'])).code).toBe(2)
}, 15_000)

test('task results survive CLI restarts, verification controls wait exit status, and comparisons retain both approaches', async () => {
  const r = await rig(); await r.importLogin()
  const task = await r.invoke(['task', 'run', 'demo', '--name', 'Check', '--command', 'printf persisted', '--verify', 'printf verified', '--wait', '--json'])
  expect(task.code).toBe(0); const saved = Task.parse(task.json())
  expect(saved.run?.result).toBe('persisted'); expect(saved.run?.verification?.output).toBe('verified')
  expect((await r.invoke(['task', 'get', saved.id, '--json'])).json().run.result).toBe('persisted')
  expect((await r.invoke(['task', 'review', saved.id, '--json'])).json().reviewedAt).not.toBeNull()
  const failed = await r.invoke(['task', 'run', 'demo', '--name', 'Failed check', '--command', 'printf done', '--verify', 'exit 3', '--wait', '--json'])
  expect(failed.code).toBe(1); expect(failed.json().run.exitCode).toBe(0); expect(failed.json().run.verification.exitCode).toBe(3)
  const compared = await r.invoke(['compare', 'run', 'demo', '--name', 'Two approaches', '--a', 'printf alpha > result; cat seed', '--b', 'printf beta > result; cat seed', '--verify', 'test -s result', '--wait', '--json'])
  expect(compared.code).toBe(0)
  const output = compared.json() as { comparison: Comparison; tasks: Task[] }
  expect(output.tasks.every((task) => task.run?.result === 'same seed')).toBe(true)
  const ids = output.comparison.vmIds
  expect(await readFile(join(r.folders.get(ids[0])!, 'result'), 'utf8')).toBe('alpha')
  expect(await readFile(join(r.folders.get(ids[1])!, 'result'), 'utf8')).toBe('beta')
  const chosen = await r.invoke(['compare', 'choose', output.comparison.id, '--task', output.tasks[0]!.id, '--json'])
  expect(chosen.code).toBe(0); expect(chosen.json().selectedTaskId).toBe(output.tasks[0]!.id)
  expect(r.records.has(ids[0])).toBe(true); expect(r.records.has(ids[1])).toBe(true)
  const foreignToken = (await r.token('bob')).token
  const denied = await fetch(r.url + '/api/tasks/' + saved.id, { headers: { authorization: `Bearer ${foreignToken}` } })
  expect(denied.status).toBe(404)
}, 30_000)

test('Ctrl+C detaches a waiting CLI without cancelling or replaying remote work', async () => {
  const r = await rig(); await r.importLogin()
  const process = r.spawn(['task', 'run', 'demo', '--name', 'Continue remotely', '--command', 'sleep 1; printf survived', '--wait'])
  let stderr = ''
  const read = (async () => { for await (const chunk of process.stderr) stderr += new TextDecoder().decode(chunk) })()
  await until(() => stderr.includes('submitted. Waiting'))
  const id = /Task ([a-f0-9-]{36})/.exec(stderr)![1]!
  process.kill('SIGINT'); expect(await process.exited).toBe(130); await read
  await Bun.sleep(1200); await r.workflows.refresh('alice')
  expect((await r.workflows.task('alice', id)).run?.state).toBe('succeeded')
  expect((await r.workflows.task('alice', id)).run?.result).toBe('survived')
  expect(r.calls.filter((call) => call.endsWith('/cancel'))).toEqual([])
  expect(r.calls.filter((call) => call === 'POST /vms/vm-alice/tasks')).toHaveLength(1)
}, 15_000)

test('logout and website revocation invalidate CLI access; failed imports preserve the saved login', async () => {
  const r = await rig(), grant = await r.importLogin()
  const path = join(r.configDir, 'credentials.json'), before = await readFile(path, 'utf8')
  const invalid = await r.invoke(['login', '--url', r.url, '--token-stdin', '--json'], 'sub_cli_' + 'x'.repeat(43))
  expect(invalid.code).toBe(1); expect(await readFile(path, 'utf8')).toBe(before)
  expect((await r.invoke(['whoami', '--json'])).json().userId).toBe('alice')
  expect((await r.invoke(['logout', '--json'])).code).toBe(0)
  expect((await r.credentials.identify(grant.token))).toBeNull()
  expect((await r.invoke(['whoami', '--json'])).code).toBe(1)
  const another = await r.importLogin(); (await r.credentials.revoke('alice', another.session.id))
  const revoked = await r.invoke(['workspace', 'list', '--json']); expect(revoked.code).toBe(1); expect(revoked.stderr).toContain('revoked')
  const disabled = await r.importLogin(); r.disabled.add('alice')
  expect((await r.invoke(['whoami', '--json'])).code).toBe(1)
  expect((await r.credentials.identify(disabled.token))).not.toBeNull()
}, 15_000)

test('credentials never follow redirects, mutation transport failures are not retried, and remote HTTP is refused', async () => {
  for (const url of ['http://remote.example', 'https://u:p@example.org', 'https://example.org/path', 'https://example.org/?token=x']) expect(() => serverOrigin(url)).toThrow()
  let calls = 0
  const redirect = new Client('https://example.org', 'private-token', (async () => { calls++; return new Response('', { status: 302, headers: { location: 'https://evil.example' } }) }))
  await expect(redirect.request('/api/vms')).rejects.toThrow('redirected'); expect(calls).toBe(1)
  calls = 0
  const lost = new Client('https://example.org', 'private-token', (async () => { calls++; throw new Error('lost response') }))
  await expect(lost.request('/api/tasks', 'POST', {})).rejects.toThrow('may have succeeded'); expect(calls).toBe(1)
  const r = await rig()
  await expect(connection('https://other.example', { ...r.env, SUBSTRATE_URL: 'https://example.org', SUBSTRATE_TOKEN: 'private' })).rejects.toThrow('belongs to')
  await mkdir(r.configDir, { recursive: true })
  await writeConfig({ defaultServer: r.url, servers: {} }, join(r.configDir, 'credentials.json'))
}, 15_000)
