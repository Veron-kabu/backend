// Apply migration 0013 to remove legacy verification artifacts
// Usage: npm run migrate:verification:cleanup

import { createClient } from '@neondatabase/serverless'
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config()

const sqlFile = path.join(process.cwd(), 'src', 'db', 'migrations', '0013_remove_legacy_verification_artifacts.sql')

async function main() {
  const connStr = process.env.DATABASE_URL
  if (!connStr) {
    console.error('DATABASE_URL not set')
    process.exit(1)
  }
  const sql = createClient({ connectionString: connStr })
  const ddl = fs.readFileSync(sqlFile, 'utf-8')
  try {
    console.log('Applying migration 0013...')
    await sql(ddl)
    console.log('Migration applied')
  } catch (e) {
    console.error('Migration failed:', e.message)
    process.exit(1)
  }
}

main()
