import { clerkClient } from '@clerk/express'
import { handleUserCreated } from '../../src/routes/webhooks.js'
import { db } from '../config/db.js'
import { clerkSyncRunsTable, usersTable } from '../db/schema.js'
import { eq } from 'drizzle-orm'

/**
 * Sync all Clerk users into the local DB (idempotent upsert).
 * @param {Object} options
 * @param {number} [options.pageSize=100]
 * @param {boolean} [options.verbose=false]
 * @param {boolean} [options.dryRun=false]
 * @returns {Promise<{processed:number}>}
 */
/**
 * Sync Clerk users into local DB.
 * @param {Object} options
 * @param {number} [options.pageSize]
 * @param {boolean} [options.verbose]
 * @param {boolean} [options.dryRun]
 * @param {string} [options.source] startup|periodic|manual|api
 * @param {boolean} [options.logDiffs] whether to log per-user change diffs
 */
export async function syncClerkUsers({ pageSize = 100, verbose = false, dryRun = false, source = 'manual', logDiffs = false } = {}) {
  if (!process.env.CLERK_SECRET_KEY) {
    throw new Error('Missing CLERK_SECRET_KEY env variable (required for server-side Clerk user listing)')
  }
  let offset = 0
  let processed = 0
  let inserted = 0
  let updated = 0
  const startedAt = Date.now()
  let runId = null
  // Pre-create run record
  try {
    const [runRow] = await db.insert(clerkSyncRunsTable).values({ source, dryRun, status: 'running' }).returning({ id: clerkSyncRunsTable.id })
    runId = runRow?.id || null
  } catch (e) {
    if (verbose) console.warn('[clerk:sync] Failed to log run start:', e.message)
  }
  if (verbose) console.log(`[clerk:sync] Starting user sync (pageSize=${pageSize}, dryRun=${dryRun})`)
  while (true) {
    const page = await clerkClient.users.getUserList({ limit: pageSize, offset })
    const users = Array.isArray(page) ? page : Array.isArray(page?.data) ? page.data : []
    if (!users || users.length === 0) break
    for (const u of users) {
      if (dryRun) {
        if (verbose) console.log(`[clerk:sync] DRY RUN would sync user ${u.id}`)
      } else {
        if (logDiffs) {
          // fetch current state for diff
          const existing = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, u.id))
          if (existing.length > 0) {
            const before = existing[0]
            const tempRes = await handleUserCreated(u)
            // fetch after for diff (only if actually updated)
            if (tempRes?.action === 'updated') {
              const afterRows = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, u.id))
              const after = afterRows[0]
              const changed = diffUser(before, after)
              if (changed.length > 0 && verbose) {
                console.log(`[clerk:sync] Updated ${u.id}: ${changed.join(', ')}`)
              }
              updated++
            } else if (tempRes?.action === 'inserted') {
              inserted++
              if (verbose) console.log(`[clerk:sync] Inserted ${u.id}`)
            }
          } else {
            const tempRes = await handleUserCreated(u)
            if (tempRes?.action === 'inserted') {
              inserted++
              if (verbose) console.log(`[clerk:sync] Inserted ${u.id}`)
            }
          }
        } else {
          const res = await handleUserCreated(u)
          if (res?.action === 'inserted') inserted++
          else if (res?.action === 'updated') updated++
        }
      }
      processed++
    }
    if (users.length < pageSize) break
    offset += pageSize
  }
  const durationMs = Date.now() - startedAt
  if (verbose) console.log(`[clerk:sync] Completed. Total processed: ${processed} (inserted=${inserted}, updated=${updated}) in ${durationMs}ms`)
  try {
    if (runId) {
      await db.update(clerkSyncRunsTable).set({
        processed,
        inserted,
        updated,
        finishedAt: new Date(),
        durationMs,
        status: 'success'
      }).where(eq(clerkSyncRunsTable.id, runId))
    }
  } catch (e) {
    if (verbose) console.warn('[clerk:sync] Failed to finalize run record:', e.message)
  }
  return { processed, inserted, updated, durationMs, runId }
}

// Helper to compute changed fields (simple shallow diff on selected columns)
function diffUser(before, after) {
  const fields = ['username','email','role','fullName','phone','location','profileImageUrl','bannerImageUrl','emailVerified','status']
  const changed = []
  for (const f of fields) {
    const b = normalize(before[f])
    const a = normalize(after[f])
    if (JSON.stringify(b) !== JSON.stringify(a)) changed.push(`${f}`)
  }
  return changed
}

function normalize(v) {
  if (v === null || v === undefined) return null
  return v
}
