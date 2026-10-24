import { SQL } from 'bun'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Db = SQL

// The control box's data (Phase 2): Postgres on RDS in production, SQLite on
// a laptop and in tests, through the same queries. The schema keeps to what
// both understand: text, integer and double precision columns (no bigint,
// which Postgres hands back as a string), snake_case names (Postgres folds
// unquoted ones to lower case), and ON CONFLICT upserts.
export function sqliteDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  return new SQL({ adapter: 'sqlite', filename: path })
}

export type PostgresOptions = {
  hostname: string
  port: number
  database: string
  username: string
  // Called for every new connection: an IAM auth token lasts 15 minutes.
  password: () => Promise<string>
  // RDS's CA bundle; connections are always TLS.
  ca?: string
}

export function postgresDatabase({ ca, ...options }: PostgresOptions): Db {
  return new SQL({ adapter: 'postgres', ...options, tls: ca ? { ca, rejectUnauthorized: true } : true, max: 10, idleTimeout: 60, connectionTimeout: 10 })
}

const MIGRATIONS: { version: number; statements: string[] }[] = [
  {
    version: 1,
    statements: [
      'create table if not exists users (id text primary key, created_at text not null, last_seen_at text not null)',
      // Which user owns which VM. Deleted ones stay, for billing and history.
      'create table if not exists vms (id text primary key, user_id text not null, created_at text not null, deleted_at text)',
      'create index if not exists vms_user on vms (user_id)',
      // Scoped preview and SSH credentials, by hash.
      'create table if not exists capabilities (hash text primary key, value text not null, expires double precision not null)',
      'create table if not exists jobs (id text primary key, user_id text not null, vm_id text not null, state text not null, error text, kind text, created_at text not null)',
      'create index if not exists jobs_user on jobs (user_id, created_at)',
      // Terminal sessions started through the control box.
      'create table if not exists sessions (id text primary key, vm_id text not null, user_id text not null, agent text, created_at text not null)',
      'create table if not exists events (id text primary key, user_id text not null, vm_id text, kind text not null, detail text, at text not null)',
      'create index if not exists events_user on events (user_id, at)',
      // Running time, for quotas and billing: seconds, vCPU-seconds and GiB-seconds per VM per month.
      `create table if not exists usage (user_id text not null, vm_id text not null, month text not null,
        running_seconds double precision not null, vcpu_seconds double precision not null, gib_seconds double precision not null,
        updated_at text not null, primary key (user_id, vm_id, month))`,
      // Per-user quota overrides (JSON); everyone else gets the defaults.
      'create table if not exists quotas (user_id text primary key, limits text not null, updated_at text not null)',
      // Users' agent keys and GitHub tokens, encrypted with KMS.
      'create table if not exists user_secrets (user_id text not null, name text not null, ciphertext text not null, hint text not null, updated_at text not null, primary key (user_id, name))',
      'create table if not exists oauth_states (state text primary key, user_id text not null, expires double precision not null)',
    ],
  },
]

export async function migrate(db: Db) {
  await db.unsafe('create table if not exists schema_migrations (version integer primary key, applied_at text not null)')
  const done = new Set((await db`select version from schema_migrations`).map((row: { version: number }) => Number(row.version)))
  for (const { version, statements } of MIGRATIONS) {
    if (done.has(version)) continue
    await db.begin(async (tx) => {
      for (const statement of statements) await tx.unsafe(statement)
      await tx`insert into schema_migrations (version, applied_at) values (${version}, ${new Date().toISOString()})`
    })
  }
}

// Once, when the control box first starts on Postgres: brings over what the
// SQLite file it used before knows (VM owners and jobs). Capabilities expire
// within the hour, so they aren't worth it.
export async function importSqlite(db: Db, path: string) {
  if (!existsSync(path)) return 0
  const [{ count } = { count: 0 }] = await db`select cast(count(*) as integer) as count from vms`
  if (Number(count) > 0) return 0
  const old = new SQL({ adapter: 'sqlite', filename: path, readonly: true })
  try {
    const tables = new Set((await old`select name from sqlite_master where type = 'table'`).map((row: { name: string }) => row.name))
    let imported = 0
    if (tables.has('vm_owners')) {
      for (const row of await old`select vm_id, user_id, created_at from vm_owners`) {
        await db`insert into vms (id, user_id, created_at) values (${row.vm_id}, ${row.user_id}, ${row.created_at}) on conflict (id) do nothing`
        imported++
      }
    }
    if (tables.has('vm_jobs')) {
      const columns = new Set((await old.unsafe('pragma table_info(vm_jobs)')).map((c: { name: string }) => c.name))
      for (const row of await old`select * from vm_jobs`) {
        const createdAt = columns.has('createdAt') && row.createdAt ? row.createdAt : new Date(0).toISOString()
        await db`insert into jobs (id, user_id, vm_id, state, error, kind, created_at)
          values (${row.id}, ${row.userId}, ${row.vmId}, ${row.state}, ${row.error}, ${columns.has('kind') ? row.kind : null}, ${createdAt})
          on conflict (id) do nothing`
      }
    }
    return imported
  } finally {
    await old.close()
  }
}

// A fresh, migrated database for a test: SQLite in memory, or, when
// TEST_DATABASE_URL is set, a schema of its own in that Postgres.
export async function testDatabase(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL
  const db = url ? await freshSchema(url) : sqliteDatabase(':memory:')
  await migrate(db)
  return db
}

async function freshSchema(url: string) {
  const schema = `test_${crypto.randomUUID().replaceAll('-', '')}`
  const admin = new SQL(url)
  await admin.unsafe(`create schema ${schema}`)
  await admin.close()
  return new SQL({ url, connection: { search_path: schema }, max: 2 })
}
