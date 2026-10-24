import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { Task, taskIsPending } from '@substrate/protocol'
import type { Db } from './db.ts'
import { taskSummary } from './task-summary.ts'

const IMPORT_ID = 'legacy-sqlite-v2'

// All legacy data, once, on either adapter. Never infer completion from a
// nonempty destination: older deployments imported only owners and jobs.
// Read a consistent source snapshot before opening the destination transaction
// (which may be the same SQLite file). No source table is changed or removed.
export async function importSqlite(db: Db, path: string) {
  if (!existsSync(path)) return 0
  if ((await db`select id from database_imports where id = ${IMPORT_ID}`).length) return 0
  const source = new Database(path, { readonly: true, strict: true })
  let legacy: Map<string, Record<string, any>[]>
  try {
    legacy = source.transaction(() => {
      const names = source.query("select name from sqlite_master where type = 'table'").all() as { name: string }[]
      return new Map(names.filter(({ name }) => TABLES.has(name)).map(({ name }) =>
        [name, source.query(`select * from "${name}"`).all() as Record<string, any>[]]))
    })()
  } finally { source.close() }
  let imported = 0
  await db.begin(async (tx) => {
    // Destination transaction owns the import marker as well as every row.
    const claim = await tx`insert into database_imports (id, completed_at) values (${IMPORT_ID}, ${new Date().toISOString()}) on conflict(id) do nothing returning id`
    if (!claim.length) return
    for (const name of BASE_TABLES) {
      const rows = legacy.get(name) ?? []
      // Table and column names are constants from our schema, never input.
      for (const row of rows) await tx`insert into ${tx(name)} ${tx(row)} on conflict do nothing`
    }
    // Once this source was migrated, its normalized tables are authoritative.
    // Old tables stay only for rollback; replaying them could resurrect revocations.
    if (legacy.get('database_imports')?.some((row) => row.id === IMPORT_ID)) return
    for (const row of legacy.get('vm_owners') ?? []) {
      const result = await tx`insert into vms (id, user_id, created_at) values (${row.vm_id}, ${row.user_id}, ${row.created_at}) on conflict(id) do nothing returning id`
      imported += result.length
    }
    for (const row of legacy.get('vm_jobs') ?? []) {
      await tx`insert into jobs (id, user_id, vm_id, state, error, kind, created_at)
        values (${row.id}, ${row.userId}, ${row.vmId}, ${row.state}, ${row.error}, ${row.kind ?? null}, ${row.createdAt ?? new Date(0).toISOString()}) on conflict(id) do nothing`
    }
    for (const row of legacy.get('agent_tasks') ?? []) {
      const task = Task.parse(JSON.parse(row.payload))
      await tx`insert into tasks (id, user_id, payload, summary, created_at, active, reviewed_at)
        values (${row.id}, ${row.user_id}, ${row.payload}, ${JSON.stringify(taskSummary(task))}, ${task.createdAt}, ${taskIsPending(task) ? 1 : 0}, ${task.reviewedAt}) on conflict(id) do nothing`
    }
    for (const row of legacy.get('agent_comparisons') ?? []) {
      const comparison = JSON.parse(row.payload)
      await tx`insert into comparisons (id, user_id, payload, created_at)
        values (${row.id}, ${row.user_id}, ${row.payload}, ${comparison.createdAt}) on conflict(id) do nothing`
    }
    for (const row of legacy.get('windows_workspaces') ?? []) {
      await tx`insert into windows_records (id, owner, name, instance_id, instance_type, state, private_ip, password, vnc_password, created_at, last_active_at, idle_stop_minutes, error)
        values (${row.id}, ${row.owner}, ${row.name}, ${row.instanceId}, ${row.instanceType}, ${row.state}, ${row.privateIp}, ${row.password}, ${row.vncPassword}, ${row.createdAt}, ${row.lastActiveAt}, ${row.idleStopMinutes}, ${row.error}) on conflict(id) do nothing`
    }
    for (const row of legacy.get('ssh_keys') ?? []) {
      await tx`insert into account_ssh_keys (id, user_id, name, public_key, fingerprint, created_at)
        values (${row.id}, ${row.userId}, ${row.name}, ${row.publicKey}, ${row.fingerprint}, ${row.createdAt}) on conflict do nothing`
    }
    for (const row of legacy.get('ssh_tokens') ?? []) {
      await tx`insert into account_ssh_tokens (id, user_id, name, hash, created_at, last_used_at)
        values (${row.id}, ${row.userId}, ${row.name}, ${row.hash}, ${row.createdAt}, ${row.lastUsedAt}) on conflict do nothing`
    }
    for (const [old, target] of [['cli_devices', 'cli_auth_devices'], ['cli_credentials', 'cli_auth_credentials']] as const) {
      for (const row of legacy.get(old) ?? []) await tx`insert into ${tx(target)} ${tx(row)} on conflict do nothing`
    }
  })
  return imported
}

// Also copy already-normalized stores if this SQLite installation has run
// Phase 2 locally before switching to RDS. Import markers are destination-local.
const BASE_TABLES = ['users', 'vms', 'capabilities', 'jobs', 'sessions', 'events', 'usage', 'quotas', 'user_secrets', 'oauth_states',
  'tasks', 'comparisons', 'windows_records', 'account_ssh_keys', 'account_ssh_tokens', 'cli_auth_devices', 'cli_auth_credentials']
const TABLES = new Set([...BASE_TABLES, 'database_imports', 'vm_owners', 'vm_jobs', 'agent_tasks', 'agent_comparisons', 'windows_workspaces', 'ssh_keys', 'ssh_tokens', 'cli_devices', 'cli_credentials'])
