import { afterAll, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { TaskSpec, type Task, type Comparison } from '@substrate/protocol'
import { importSqlite, migrate, sqliteDatabase, testDatabase, type Db } from './db.ts'
import { Owners } from './owners.ts'
import { WorkflowStore } from './workflow-store.ts'
import { WindowsStore } from './windows/store.ts'
import { SshAccess } from './ssh-access.ts'
import { CliCredentials } from './cli-auth.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterAll(async () => { for (const clean of cleanup.reverse()) await clean() })
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const at = '2026-10-24T01:00:00.000Z'
const task: Task = { id: '00000000-0000-4000-8000-000000000001', vmId: 'vm-legacy', comparisonId: '00000000-0000-4000-8000-000000000003', createdAt: at,
  reviewedAt: at, spec: TaskSpec.parse({ title: 'Saved result', runner: 'command', input: 'printf retained' }),
  run: null, error: 'Saved preparation failure', dispatchUncertain: false }
const comparison: Comparison = { id: '00000000-0000-4000-8000-000000000003', title: 'Retained approaches', sourceVmId: 'vm-legacy',
  vmIds: ['vm-a', 'vm-b'], taskIds: [task.id, '00000000-0000-4000-8000-000000000002'], createdAt: at, state: 'ready', sourceCheckpointId: '00000000-0000-4000-8000-000000000004', selectedTaskId: task.id, error: null }

async function legacy() {
  const directory = await mkdtemp(join(tmpdir(), 'substrate-migration-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'control.db')
  const old = new Database(path)
  old.run('create table vm_owners (vm_id text primary key, user_id text, created_at text)')
  old.query('insert into vm_owners values (?, ?, ?)').run('vm-legacy', 'alice', at)
  old.run('create table vm_jobs (id text, userId text, vmId text, state text, error text)')
  old.query('insert into vm_jobs values (?, ?, ?, ?, ?)').run('job-legacy', 'alice', 'vm-legacy', 'done', null)
  // Deliberately no summary column: import recomputes it from the payload.
  old.run('create table agent_tasks (id text primary key, user_id text, payload text)')
  old.query('insert into agent_tasks values (?, ?, ?)').run(task.id, 'alice', JSON.stringify(task))
  old.run('create table agent_comparisons (id text primary key, user_id text, payload text)')
  old.query('insert into agent_comparisons values (?, ?, ?)').run(comparison.id, 'alice', JSON.stringify(comparison))
  old.run('create table windows_workspaces (id text primary key, owner text, name text, instanceId text, instanceType text, state text, privateIp text, password text, vncPassword text, createdAt text, lastActiveAt text, idleStopMinutes integer, error text)')
  old.query('insert into windows_workspaces values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('win-legacy', 'alice', 'Windows', 'instance-legacy', 'm8i.4xlarge', 'stopped', '10.0.0.1', 'private-password', 'vnc-pass', at, at, null, null)
  old.run('create table ssh_keys (id text, userId text, name text, publicKey text, fingerprint text, createdAt text)')
  old.query('insert into ssh_keys values (?, ?, ?, ?, ?, ?)').run('key-legacy', 'alice', 'Laptop', 'ssh-ed25519 AAAA example', 'SHA256:example', at)
  old.run('create table ssh_tokens (id text, userId text, name text, hash text, createdAt text, lastUsedAt text)')
  old.query('insert into ssh_tokens values (?, ?, ?, ?, ?, ?)').run('ssh-legacy', 'alice', 'Laptop', digest('sbs_legacy'), at, null)
  old.run('create table cli_devices (hash text, code text, name text, expires integer, state text, user_id text, last_poll integer)')
  old.query('insert into cli_devices values (?, ?, ?, ?, ?, ?, ?)').run(digest('device-secret'), 'ABCD-EFGH', 'Pending laptop', Date.now() + 600_000, 'approved', 'alice', 0)
  old.run('create table cli_credentials (id text, hash text, user_id text, name text, created integer, expires integer, last_used integer)')
  old.query('insert into cli_credentials values (?, ?, ?, ?, ?, ?, ?)').run('cli-legacy', digest('sub_cli_legacy'), 'alice', 'Existing login', Date.now(), Date.now() + 86_400_000, null)
  old.close()
  return path
}

async function assertImported(db: Db) {
  const store = new WorkflowStore(db), ssh = new SshAccess(db), cli = new CliCredentials(db), windows = new WindowsStore(db)
  expect(await new Owners(db).owner('vm-legacy')).toBe('alice')
  expect(await store.task('alice', task.id)).toEqual(task)
  expect(await store.task('bob', task.id)).toBeNull()
  expect((await store.comparison('alice', comparison.id))?.selectedTaskId).toBe(task.id)
  expect((await store.summaries('alice'))[0]?.reviewedAt).toBe(at)
  expect(await store.users()).toEqual([])
  expect(await windows.get('win-legacy')).toMatchObject({ owner: 'alice', instanceId: 'instance-legacy', password: 'private-password', vncPassword: 'vnc-pass', idleStopMinutes: null })
  expect(await windows.of('bob')).toEqual([])
  expect((await ssh.keys('alice'))[0]).toMatchObject({ id: 'key-legacy', publicKey: 'ssh-ed25519 AAAA example' })
  expect(await ssh.userForToken('sbs_legacy')).toBe('alice')
  expect((await cli.identify('sub_cli_legacy'))?.userId).toBe('alice')
  const grant = await cli.poll('device-secret')
  expect(grant?.userId).toBe('alice')
  await expect(cli.poll('device-secret')).rejects.toThrow('already redeemed')
  expect(await cli.revoke('bob', 'cli-legacy')).toBe(false)
  expect(await cli.revoke('alice', 'cli-legacy')).toBe(true)
  expect(await cli.identify('sub_cli_legacy')).toBeNull()
}

test('imports every legacy store despite an existing owner, preserving credentials, selections and review state', async () => {
  const path = await legacy(), db = await testDatabase()
  cleanup.push(() => db.close())
  await new Owners(db).add('vm-already-imported', 'bob')
  expect(await importSqlite(db, path)).toBe(1)
  await assertImported(db)
  await new Owners(db).remove('vm-legacy')
  expect(await importSqlite(db, path)).toBe(0)
  expect(await new Owners(db).owner('vm-legacy')).toBeNull()
  expect(await new CliCredentials(db).identify('sub_cli_legacy')).toBeNull()
  const old = new Database(path, { readonly: true })
  expect(old.query('select count(*) as n from cli_credentials').get()).toEqual({ n: 1 })
  old.close()
})

test('migration also works in the same SQLite file, then a later switch to Postgres/another database copies normalized data', async () => {
  const path = await legacy(), local = sqliteDatabase(path)
  cleanup.push(() => local.close())
  await migrate(local)
  await importSqlite(local, path)
  await new CliCredentials(local).revoke('alice', 'cli-legacy')
  const target = await testDatabase(); cleanup.push(() => target.close())
  await importSqlite(target, path)
  // A deleted normalized credential must not be resurrected from legacy tables.
  expect(await new CliCredentials(target).identify('sub_cli_legacy')).toBeNull()
  expect((await new WorkflowStore(target).task('alice', task.id))?.reviewedAt).toBe(at)
})

test('failed imports roll back the entire batch and completion marker, so fixing the source permits a safe retry', async () => {
  const path = await legacy(), db = await testDatabase()
  cleanup.push(() => db.close())
  const old = new Database(path)
  old.query('update agent_tasks set payload = ?').run('{bad JSON')
  await expect(importSqlite(db, path)).rejects.toThrow()
  expect(await new Owners(db).owner('vm-legacy')).toBeNull()
  expect(await db`select id from database_imports`).toHaveLength(0)
  old.query('update agent_tasks set payload = ?').run(JSON.stringify(task)); old.close()
  expect(await importSqlite(db, path)).toBe(1)
  expect(await new Owners(db).owner('vm-legacy')).toBe('alice')
})

test('concurrent CLI redemption and approval have exactly one winner', async () => {
  const db = await testDatabase(); cleanup.push(() => db.close())
  const cli = new CliCredentials(db), request = await cli.begin('Race')
  const decisions = await Promise.allSettled([cli.decide(request.userCode, 'alice', true), cli.decide(request.userCode, 'bob', true)])
  expect(decisions.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  const redemptions = await Promise.allSettled([cli.poll(request.deviceCode), cli.poll(request.deviceCode)])
  expect(redemptions.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  expect((await cli.list('alice')).length + (await cli.list('bob')).length).toBe(1)
})

test('a stale task refresh cannot overwrite a concurrent review or unreview action', async () => {
  const db = await testDatabase(); cleanup.push(() => db.close())
  const store = new WorkflowStore(db)
  await store.saveTask('alice', task)
  const stale = (await store.task('alice', task.id))!
  await store.review('alice', task.id, null)
  await store.saveTask('alice', stale)
  expect((await store.task('alice', task.id))?.reviewedAt).toBeNull()
  await store.review('alice', task.id, at)
  await store.saveTask('alice', { ...stale, reviewedAt: null })
  expect((await store.summaries('alice'))[0]?.reviewedAt).toBe(at)
})
