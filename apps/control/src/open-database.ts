import { config } from './config.ts'
import { openRds } from './database.ts'
import { importSqlite, migrate, sqliteDatabase } from './db.ts'

// The control box's database as configured: Postgres on RDS once it's set
// up; until then (and on a laptop) SQLite. The first start on Postgres brings
// over what the SQLite file knew.
export async function openDatabase() {
  const db = config.database ? await openRds(config.database, config.region) : sqliteDatabase(config.db)
  await migrate(db)
  const imported = await importSqlite(db, config.db)
  if (imported) console.log(`database: imported ${imported} legacy VM owners; legacy data migration complete`)
  return db
}
