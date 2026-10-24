import { config } from './config.ts'
import { openRds } from './database.ts'
import { importSqlite, migrate, sqliteDatabase } from './db.ts'

// The control box's database as configured: Postgres on RDS once it's set
// up; until then (and on a laptop) SQLite. The first start on Postgres brings
// over what the SQLite file knew.
export async function openDatabase() {
  const db = config.database ? await openRds(config.database, config.region) : sqliteDatabase(config.db)
  await migrate(db)
  if (config.database) {
    const imported = await importSqlite(db, config.db)
    if (imported) console.log(`database: brought ${imported} VM owners over from ${config.db}`)
  }
  return db
}
