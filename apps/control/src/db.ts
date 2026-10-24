import { SQL } from 'bun'
import { mkdirSync } from 'node:fs'
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
  {
    version: 2,
    statements: [
      'create table if not exists store_locks (id text primary key)',
      // Separate names keep old SQLite tables intact for import and rollback.
      `create table if not exists tasks (id text primary key, user_id text not null, payload text not null,
        summary text not null, created_at text not null, active integer not null, reviewed_at text)`,
      'create index if not exists tasks_owner_created on tasks(user_id, created_at)',
      'create index if not exists tasks_active on tasks(active, user_id)',
      'create table if not exists comparisons (id text primary key, user_id text not null, payload text not null, created_at text not null)',
      'create index if not exists comparisons_owner_created on comparisons(user_id, created_at)',
      `create table if not exists windows_records (
        id text primary key, owner text not null, name text not null, instance_id text, instance_type text not null,
        state text not null, private_ip text, password text not null, vnc_password text not null,
        created_at text not null, last_active_at text not null, idle_stop_minutes integer, error text)`,
      'create index if not exists windows_records_owner on windows_records(owner, created_at)',
      `create table if not exists account_ssh_keys (id text primary key, user_id text not null, name text not null,
        public_key text not null, fingerprint text not null, created_at text not null, unique(user_id, fingerprint))`,
      `create table if not exists account_ssh_tokens (id text primary key, user_id text not null, name text not null,
        hash text not null unique, created_at text not null, last_used_at text)`,
      'create index if not exists account_ssh_tokens_owner on account_ssh_tokens(user_id)',
      `create table if not exists cli_auth_devices (hash text primary key, code text unique not null, name text not null,
        expires double precision not null, state text not null, user_id text, last_poll double precision not null)`,
      `create table if not exists cli_auth_credentials (id text primary key, hash text unique not null, user_id text not null,
        name text not null, created double precision not null, expires double precision not null, last_used double precision)`,
      'create index if not exists cli_auth_credentials_owner on cli_auth_credentials(user_id)',
      'create table if not exists database_imports (id text primary key, completed_at text not null)',
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

export { importSqlite } from './legacy-import.ts'

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
