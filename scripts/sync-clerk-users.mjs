#!/usr/bin/env node
/**
 * Backfill / reconcile local Postgres users table with Clerk directory.
 * Use when webhooks were missed. Safe to re-run (idempotent upsert logic).
 *
 * Usage (PowerShell):  node ./scripts/sync-clerk-users.mjs
 * Required env: CLERK_SECRET_KEY, DB creds (see existing env config).
 */
import 'dotenv/config'
import { clerkClient } from '@clerk/express'
import { db } from '../src/config/db.js'
import { usersTable } from '../src/db/schema.js'
import { eq } from 'drizzle-orm'
import { handleUserCreated } from '../src/routes/webhooks.js'

async function main() {
  if (!process.env.CLERK_SECRET_KEY) {
    console.error('Missing CLERK_SECRET_KEY in env (required for listing users)')
    process.exit(1)
  }

  console.log('🔄 Fetching users from Clerk...')
  const pageSize = 100
  let totalProcessed = 0
    let inserted = 0
    let updated = 0
  let offset = 0
  while (true) {
      const page = await clerkClient.users.getUserList({ limit: pageSize, offset })
      const users = Array.isArray(page) ? page : Array.isArray(page?.data) ? page.data : []
      if (!users || users.length === 0) break
      for (const u of users) {
        const res = await handleUserCreated(u)
        if (res?.action === 'inserted') inserted++
        else if (res?.action === 'updated') updated++
        totalProcessed++
      }
      if (users.length < pageSize) break
    offset += pageSize
  }
    console.log(`✅ Sync complete. Processed ${totalProcessed} user(s). Inserted: ${inserted}, Updated: ${updated}`)
}

main().catch(err => {
  console.error('Sync failed:', err)
  process.exit(1)
})
