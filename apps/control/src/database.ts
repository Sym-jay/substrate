import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { Signer } from '@aws-sdk/rds-signer'
import { SQL } from 'bun'
import { postgresDatabase, type Db } from './db.ts'

type RdsConfig = {
  hostname: string
  port: number
  database: string
  username: string
  masterSecretArn: string | null
  caFile: string | null
}

// The control box's Postgres on RDS. It signs in as its own user with IAM
// (rds-db:connect), a fresh 15-minute token per connection, so no database
// password is stored anywhere. The first time, that user doesn't exist yet:
// it's made with the master credentials RDS keeps (and rotates) in Secrets
// Manager.
export async function openRds(rds: RdsConfig, region: string): Promise<Db> {
  const ca = rds.caFile ? await Bun.file(rds.caFile).text() : undefined
  const signer = new Signer({ hostname: rds.hostname, port: rds.port, username: rds.username, region })
  const connect = () => postgresDatabase({ hostname: rds.hostname, port: rds.port, database: rds.database, username: rds.username, password: () => signer.getAuthToken(), ca })
  let db = connect()
  try {
    await db`select 1`
    return db
  } catch (err) {
    await db.close().catch(() => {})
    if (!rds.masterSecretArn) throw err
    console.log(`database: can't sign in as ${rds.username} (${(err as Error).message}); creating it`)
  }
  await createAppUser(rds, region, ca)
  db = connect()
  await db`select 1`
  return db
}

async function createAppUser(rds: RdsConfig, region: string, ca: string | undefined) {
  const secrets = new SecretsManagerClient({ region })
  const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: rds.masterSecretArn! }))
  const master = JSON.parse(SecretString!) as { username: string; password: string }
  const admin = new SQL({
    adapter: 'postgres', hostname: rds.hostname, port: rds.port, database: rds.database,
    username: master.username, password: master.password, tls: ca ? { ca, rejectUnauthorized: true } : true, max: 1,
  })
  try {
    // Identifiers can't be parameters; the user name is checked instead.
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(rds.username) || !/^[a-z_][a-z0-9_]{0,62}$/.test(rds.database)) throw new Error('bad database or user name')
    await admin.unsafe(`do $$ begin if not exists (select from pg_roles where rolname = '${rds.username}') then create role ${rds.username} login; end if; end $$`)
    await admin.unsafe(`grant rds_iam to ${rds.username}`)
    await admin.unsafe(`grant connect, temporary on database ${rds.database} to ${rds.username}`)
    await admin.unsafe(`grant usage, create on schema public to ${rds.username}`)
  } finally {
    await admin.close()
  }
}
