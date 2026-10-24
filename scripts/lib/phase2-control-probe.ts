// Compiled for the control box by check:phase2. Uses its instance role and
// environment; neither credentials nor database contents are printed.
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { config } from '../../apps/control/src/config.ts'
import { openRds } from '../../apps/control/src/database.ts'
import { CliCredentials } from '../../apps/control/src/cli-auth.ts'
import { SshAccess } from '../../apps/control/src/ssh-access.ts'
import { WorkflowStore } from '../../apps/control/src/workflow-store.ts'
import { WindowsStore, toWorkspace } from '../../apps/control/src/windows/store.ts'
import { kmsCipher, UserSecrets } from '../../apps/control/src/secrets.ts'
import { TaskSpec, type Task } from '@substrate/protocol'
import { Database } from 'bun:sqlite'

if (!config.database) throw new Error('Postgres is not configured')
const db = await openRds(config.database, config.region)
const check = (label: string, ok: boolean) => { if (!ok) throw new Error(label); console.log(`ok ${label}`) }
try {
  const [identity] = await db`select current_user as username, current_database() as database, version() as version`
  check('RDS IAM login uses the application role on Postgres', identity.username === config.database.username && identity.version.startsWith('PostgreSQL'))
  const [tls] = await db`select ssl from pg_stat_ssl where pid = pg_backend_pid()`
  check('RDS connection uses TLS', tls.ssl === true)
  const tables = (await db`select tablename from pg_tables where schemaname = current_schema() order by tablename`).map((r: { tablename: string }) => r.tablename)
  const counts: Record<string, number> = {}
  for (const name of tables) { const [row] = await db`select cast(count(*) as integer) as n from ${db(name)}`; counts[name] = row.n }
  console.log('table counts', JSON.stringify(counts))
  console.log('GitHub OAuth configured', !!config.githubOAuth)
  if (process.argv.includes('--backup')) {
    const directory = '/var/lib/substrate/backups'
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const snapshot = await db.begin('isolation level repeatable read read only', async (tx) => {
      const rows: Record<string, unknown> = {}
      for (const name of tables) rows[name] = await tx`select * from ${tx(name)}`
      return rows
    })
    const file = `${directory}/phase2-before-${Date.now()}.json`
    await writeFile(file, JSON.stringify(snapshot), { mode: 0o600 })
    console.log('RDS backup saved on control box', file)
    process.exitCode = 0
  } else {
    check('all shared database migrations applied', (await db`select version from schema_migrations order by version`).some((r: { version: number }) => r.version === 2))
    if (existsSync(config.db)) {
      check('legacy SQLite import committed', (await db`select id from database_imports where id = 'legacy-sqlite-v2'`).length === 1)
      const legacy = new Database(config.db, { readonly: true })
      try {
        const tables = new Set((legacy.query("select name from sqlite_master where type='table'").all() as { name: string }[]).map(row => row.name))
        if (tables.has('cli_credentials')) {
          const rows = legacy.query('select id, hash, user_id, expires from cli_credentials where expires > ?').all(Date.now()) as { id: string; hash: string; user_id: string; expires: number }[]
          for (const row of rows) {
            const [retained] = await db`select id from cli_auth_credentials where id = ${row.id} and hash = ${row.hash} and user_id = ${row.user_id} and expires = ${row.expires}`
            check('preexisting CLI credential hash, owner and expiry retained', !!retained)
          }
        }
        if (tables.has('agent_tasks')) {
          const rows = legacy.query('select id, user_id from agent_tasks').all() as { id: string; user_id: string }[]
          for (const row of rows) check('legacy task history remains owner-scoped', !!await new WorkflowStore(db).task(row.user_id, row.id))
        }
      } finally { legacy.close() }
    }
    const owner = `phase2-check-${randomUUID()}`, at = new Date().toISOString()
    const cli = new CliCredentials(db), ssh = new SshAccess(db), workflows = new WorkflowStore(db), windows = new WindowsStore(db)
    try {
      const grant = await cli.begin('Phase 2 database check')
      await cli.decide(grant.userCode, owner, true)
      const token = (await cli.poll(grant.deviceCode))!
      check('CLI grant persists through a new store instance', (await new CliCredentials(db).identify(token.token))?.userId === owner)
      check('CLI credentials are owner-scoped', !(await cli.revoke('foreign', token.session.id)))
      check('CLI revocation persists', await cli.revoke(owner, token.session.id) && !await cli.identify(token.token))
      const key = await ssh.addKey(owner, { publicKey: 'ssh-ed25519 AAAA phase2-check' })
      const transport = await ssh.createToken(owner, 'Phase 2 check')
      check('SSH key and token persist in RDS', (await ssh.keys(owner))[0]?.id === key.id && await new SshAccess(db).userForToken(transport.token) === owner)
      await ssh.revokeToken(owner, transport.id)
      check('SSH revocation persists', await ssh.userForToken(transport.token) === null)
      const task: Task = { id: randomUUID(), vmId: 'vm-check', comparisonId: null, createdAt: at, reviewedAt: null,
        spec: TaskSpec.parse({ title: 'Database round trip', runner: 'command', input: 'true' }), run: null, error: 'Database-only check', dispatchUncertain: false }
      await workflows.saveTask(owner, task)
      await workflows.review(owner, task.id, at)
      check('task results/review persist in RDS', (await new WorkflowStore(db).task(owner, task.id))?.reviewedAt === at && !await workflows.task('foreign', task.id))
      await windows.add({ id: owner, owner, name: 'Database-only check', instanceId: null, instanceType: 'none', state: 'stopped', privateIp: null,
        password: randomUUID(), vncPassword: 'testonly', createdAt: at, lastActiveAt: at, idleStopMinutes: null, error: null })
      await windows.update(owner, { idleStopMinutes: 10 })
      const row = (await windows.get(owner))!
      check('Windows record persists without leaking passwords', row.idleStopMinutes === 10 && !('password' in toWorkspace(row)) && !(await windows.of('foreign')).length)
      if (!config.kmsKeyId) throw new Error('KMS key is not configured')
      const secrets = new UserSecrets(db, kmsCipher(config.region, config.kmsKeyId)), value = randomUUID()
      await secrets.set(owner, 'anthropic', value, value.slice(-4))
      check('KMS encrypt/decrypt round trip using control instance role', await secrets.get(owner, 'anthropic') === value)
      const [sealed] = await db`select ciphertext from user_secrets where user_id = ${owner}`
      check('RDS stores ciphertext, not the original secret', sealed.ciphertext !== value && !sealed.ciphertext.includes(value))
      const cipher = kmsCipher(config.region, config.kmsKeyId)
      let rejected = false
      try { await cipher.decrypt(sealed.ciphertext, { purpose: 'substrate-user-secret', user: 'foreign', name: 'anthropic' }) } catch { rejected = true }
      check('KMS refuses another user encryption context', rejected)
    } finally {
      for (const table of ['cli_auth_devices', 'cli_auth_credentials', 'account_ssh_keys', 'account_ssh_tokens', 'tasks', 'user_secrets']) {
        await db`delete from ${db(table)} where user_id = ${owner}`
      }
      await windows.remove(owner)
      // Only the test's lock rows, never shared locks.
      for (const name of [`cli-sessions:${owner}`, `ssh-keys:${owner}`, `ssh-tokens:${owner}`]) await db`delete from store_locks where id = ${name}`
    }
    check('temporary acceptance records removed', !(await db`select id from tasks where user_id like 'phase2-check-%'`).length)
  }
} finally { await db.close() }
