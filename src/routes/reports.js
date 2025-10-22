import { Router } from 'express'
import { db } from '../config/db.js'
import { ensureAuth, clerkClient } from '../middleware/auth.js'
import { requireRole } from '../middleware/role.js'
import { usersTable, userReportsTable, reportAppealsTable, ordersTable, orderStatusHistoryTable, userNotificationsTable } from '../db/schema.js'
import { eq, sql, and, or, inArray } from 'drizzle-orm'
import { createNotification } from '../utils/notifications.js'
import { handleUserCreated } from './webhooks.js'

const router = Router()

// Idempotent guard to ensure moderation tables exist when migrations haven't run yet
let reportsTablesEnsured = false
async function ensureReportsTables() {
  if (reportsTablesEnsured) return
  try {
    // Create user_reports if missing
    await db.execute(sql`CREATE TABLE IF NOT EXISTS "user_reports" (
      "id" serial PRIMARY KEY NOT NULL,
      "reported_user_id" integer NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
      "reporter_id" integer NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
      "reason_code" varchar(32) NOT NULL,
      "description" text,
      "evidence_media_links" jsonb DEFAULT '[]'::jsonb,
  "status" varchar(20) DEFAULT 'pending',
      "created_at" timestamp DEFAULT now(),
      "validated_by_user_id" integer REFERENCES "public"."users"("id"),
      "validated_at" timestamp,
      "resolution_note" text
    )`)

    // Create report_appeals if missing
    await db.execute(sql`CREATE TABLE IF NOT EXISTS "report_appeals" (
      "id" serial PRIMARY KEY NOT NULL,
      "report_id" integer NOT NULL REFERENCES "public"."user_reports"("id") ON DELETE cascade,
      "user_id" integer NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
      "reason" text,
      "status" varchar(20) DEFAULT 'open',
      "created_at" timestamp DEFAULT now(),
      "resolved_at" timestamp,
      "resolver_user_id" integer REFERENCES "public"."users"("id"),
      "resolution_note" text
    )`)
    reportsTablesEnsured = true
  } catch (e) {
    // If ensure fails, keep flag false so we retry on next call
    console.error('ensureReportsTables failed (non-fatal):', e?.message || e)
  }
}

// Submit a user report
router.post('/reports', ensureAuth(), async (req, res) => {
  try {
    await ensureReportsTables()
    const { reported_user_id, reason_code, description, evidence_media_links } = req.body || {}
    // reported_user_id can be either a username (string non-numeric) or a numeric user id.
    let reportedId = null
    if (typeof reported_user_id === 'string') {
      const raw = reported_user_id.trim()
      const asNum = Number(raw)
      if (Number.isFinite(asNum)) {
        reportedId = asNum
      } else {
        // Treat as username
        if (!raw) return res.status(400).json({ error: 'reported_user_id is required (username or numeric id)' })
        const targetArr = await db.select().from(usersTable).where(eq(usersTable.username, raw))
        if (!targetArr.length) return res.status(404).json({ error: 'Reported user not found' })
        reportedId = targetArr[0].id
      }
    } else {
      const num = Number(reported_user_id)
      if (!Number.isFinite(num)) return res.status(400).json({ error: 'reported_user_id is required (username or numeric id)' })
      reportedId = num
    }
    if (!reason_code) return res.status(400).json({ error: 'reason_code required' })
    const meArr = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    if (!meArr.length) return res.status(403).json({ error: 'Unauthorized' })
    const me = meArr[0]
    if (me.id === reportedId) return res.status(400).json({ error: 'Cannot report yourself' })
    const inserted = await db.insert(userReportsTable).values({
      reportedUserId: reportedId,
      reporterId: me.id,
      reasonCode: reason_code,
      description: description || null,
      evidenceMediaLinks: Array.isArray(evidence_media_links) ? evidence_media_links : [],
  status: 'pending',
    }).returning()
    // Notify the reported user (in-app)
    await createNotification(db, { userId: reportedId, type: 'report', title: 'You were reported', body: 'An admin will review the report. You can appeal if action is taken.' })
    return res.json(inserted[0])
  } catch (e) {
    console.error('submit report failed', e)
    return res.status(500).json({ error: 'Failed to submit report' })
  }
})

// Admin: list reports
router.get('/admin/reports', ensureAuth(), requireRole(['admin']), async (req, res) => {
  try {
    await ensureReportsTables()
    // Include reported user's current status for admin UI decisions
    const rows = await db.select({
      id: userReportsTable.id,
      reportedUserId: userReportsTable.reportedUserId,
      reporterId: userReportsTable.reporterId,
      reasonCode: userReportsTable.reasonCode,
      description: userReportsTable.description,
      evidenceMediaLinks: userReportsTable.evidenceMediaLinks,
      status: userReportsTable.status,
      createdAt: userReportsTable.createdAt,
      validatedByUserId: userReportsTable.validatedByUserId,
      validatedAt: userReportsTable.validatedAt,
      resolutionNote: userReportsTable.resolutionNote,
      reportedUserStatus: usersTable.status,
      pausedOrdersCount: sql`(
        SELECT COUNT(*)::int FROM orders o
        WHERE o.status = 'paused' AND (o.buyer_id = ${usersTable.id} OR o.farmer_id = ${usersTable.id})
      )`,
      lastSuspendedAt: sql`(
        SELECT MAX(n.created_at) FROM ${userNotificationsTable} n
        WHERE n.user_id = ${usersTable.id} AND (
          n.type = 'account_suspended' OR (n.type = 'moderation' AND n.title = 'Account suspended')
        )
      )`,
      lastReactivatedAt: sql`(
        SELECT MAX(n.created_at) FROM ${userNotificationsTable} n
        WHERE n.user_id = ${usersTable.id} AND n.type = 'account_reactivated'
      )`,
    })
    .from(userReportsTable)
    .leftJoin(usersTable, eq(userReportsTable.reportedUserId, usersTable.id))
    rows.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))
    // Backward-compat: map legacy 'open' to 'pending' for clients, no severity
    const items = rows.map(r => ({ ...r, status: r.status === 'open' ? 'pending' : r.status }))
    return res.json({ items, total: items.length })
  } catch (e) {
    console.error('list reports failed', e)
    return res.status(500).json({ error: 'Failed to fetch reports' })
  }
})

// Admin: validate report -> apply strike and optional suspension at threshold
router.post('/admin/reports/:id/validate', ensureAuth(), requireRole(['admin']), async (req, res) => {
  try {
    await ensureReportsTables()
    const idNum = Number(req.params.id)
    const { resolution_note } = req.body || {}
    if (!Number.isFinite(idNum)) return res.status(400).json({ error: 'Invalid id' })
    // Ensure the acting admin exists in DB; backfill from Clerk if missing
    let meArr = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    if (meArr.length === 0) {
      try {
        const clerkUser = await clerkClient.users.getUser(req.auth.userId)
        if (clerkUser) await handleUserCreated(clerkUser)
      } catch {}
      meArr = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
      if (meArr.length === 0) return res.status(403).json({ error: 'Unauthorized: admin user not provisioned' })
    }
    const admin = meArr[0]
    const rows = await db.select().from(userReportsTable).where(eq(userReportsTable.id, idNum))
    if (!rows.length) return res.status(404).json({ error: 'Report not found' })
    const r = rows[0]
  if (!(r.status === 'pending' || r.status === 'open')) return res.status(400).json({ error: 'Report already processed' })
    // mark validated
    const updated = await db.update(userReportsTable).set({ status: 'validated', validatedByUserId: admin.id, validatedAt: new Date(), resolutionNote: resolution_note || null }).where(eq(userReportsTable.id, idNum)).returning()
    // apply strike
    const targetArr = await db.select().from(usersTable).where(eq(usersTable.id, r.reportedUserId))
    if (targetArr.length) {
      const target = targetArr[0]
      const strikes = (target.strikesCount || 0) + 1
      let status = target.status
      const threshold = Number(process.env.STRIKES_SUSPEND_THRESHOLD || 3)
      if (strikes >= threshold) status = 'suspended'
      await db.update(usersTable).set({ strikesCount: strikes, status, updatedAt: new Date() }).where(eq(usersTable.id, target.id))
      const body = status === 'suspended' ? `Your account was suspended after ${strikes} strikes. You may appeal.` : `A strike was added to your account. Total strikes: ${strikes}.`
      await createNotification(db, {
        userId: target.id,
        type: 'moderation',
        title: status === 'suspended' ? 'Account suspended' : 'Strike applied',
        body,
        data: status === 'suspended' ? { route: '/appeals', reportId: idNum } : undefined,
      })
      // If this action caused a suspension, pause ongoing orders
      if (status === 'suspended') {
        try {
          const activeStatuses = ['pending','accepted','shipped']
          const affected = await db.update(ordersTable)
            .set({ status: 'paused', updatedAt: new Date() })
            .where(and(inArray(ordersTable.status, activeStatuses), or(eq(ordersTable.buyerId, target.id), eq(ordersTable.farmerId, target.id))))
            .returning()
          if (affected?.length && admin?.id) {
            for (const ord of affected) {
              await db.insert(orderStatusHistoryTable).values({
                orderId: ord.id,
                fromStatus: null,
                toStatus: 'paused',
                changedByUserId: admin.id,
              })
            }
          }
        } catch (e) { console.warn('pause orders on validate-suspend failed', e?.message || e) }
      }
    }
    return res.json({ ok: true, report: updated[0] })
  } catch (e) {
    console.error('validate report failed', e)
    return res.status(500).json({ error: 'Failed to validate report' })
  }
})

// Admin: reject report
router.post('/admin/reports/:id/reject', ensureAuth(), requireRole(['admin']), async (req, res) => {
  try {
    await ensureReportsTables()
    const idNum = Number(req.params.id)
    const { resolution_note } = req.body || {}
    if (!Number.isFinite(idNum)) return res.status(400).json({ error: 'Invalid id' })
    // Ensure the acting admin exists in DB; backfill from Clerk if missing
    let meArr = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    if (meArr.length === 0) {
      try {
        const clerkUser = await clerkClient.users.getUser(req.auth.userId)
        if (clerkUser) await handleUserCreated(clerkUser)
      } catch {}
      meArr = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
      if (meArr.length === 0) return res.status(403).json({ error: 'Unauthorized: admin user not provisioned' })
    }
    const admin = meArr[0]
    const rows = await db.select().from(userReportsTable).where(eq(userReportsTable.id, idNum))
    if (!rows.length) return res.status(404).json({ error: 'Report not found' })
    const r = rows[0]
  if (!(r.status === 'pending' || r.status === 'open')) return res.status(400).json({ error: 'Report already processed' })
    const updated = await db.update(userReportsTable).set({ status: 'rejected', validatedByUserId: admin.id, validatedAt: new Date(), resolutionNote: resolution_note || null }).where(eq(userReportsTable.id, idNum)).returning()
    return res.json({ ok: true, report: updated[0] })
  } catch (e) {
    console.error('reject report failed', e)
    return res.status(500).json({ error: 'Failed to reject report' })
  }
})

// User appeal of a validated report
router.post('/reports/:id/appeal', ensureAuth(), async (req, res) => {
  try {
    await ensureReportsTables()
    const idNum = Number(req.params.id)
    const { reason } = req.body || {}
    if (!Number.isFinite(idNum)) return res.status(400).json({ error: 'Invalid id' })
    const meArr = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    if (!meArr.length) return res.status(403).json({ error: 'Unauthorized' })
    const me = meArr[0]
    // Prevent duplicate open appeals for the same report by the same user
    try {
      const existing = await db.select().from(reportAppealsTable)
      const openExisting = existing.find(a => a.reportId === idNum && a.userId === me.id && String(a.status) === 'open')
      if (openExisting) return res.json(openExisting)
    } catch {}
    const inserted = await db.insert(reportAppealsTable).values({ reportId: idNum, userId: me.id, reason: reason || null }).returning()
    return res.json(inserted[0])
  } catch (e) {
    console.error('create appeal failed', e)
    return res.status(500).json({ error: 'Failed to create appeal' })
  }
})

// User: Appeal latest validated report linked to the current user (for generic suspension appeals)
router.post('/reports/appeal-latest', ensureAuth(), async (req, res) => {
  try {
    await ensureReportsTables()
    const { reason } = req.body || {}
    const meArr = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    if (!meArr.length) return res.status(403).json({ error: 'Unauthorized' })
    const me = meArr[0]
    // Find latest validated report against this user
    let rows = await db.select().from(userReportsTable).where(eq(userReportsTable.reportedUserId, me.id))
    rows = rows.filter(r => String(r.status) === 'validated').sort((a,b) => new Date(b.validatedAt || b.createdAt) - new Date(a.validatedAt || a.createdAt))
    const latest = rows[0]
    if (!latest) return res.status(404).json({ error: 'No validated report found to appeal' })
    // Guard duplicate open appeal
    try {
      const existing = await db.select().from(reportAppealsTable)
      const openExisting = existing.find(a => a.reportId === latest.id && a.userId === me.id && String(a.status) === 'open')
      if (openExisting) return res.json(openExisting)
    } catch {}
    const inserted = await db.insert(reportAppealsTable).values({ reportId: latest.id, userId: me.id, reason: reason || null }).returning()
    return res.json(inserted[0])
  } catch (e) {
    console.error('appeal-latest failed', e)
    return res.status(500).json({ error: 'Failed to create appeal' })
  }
})

// List current user's report appeals
router.get('/reports/my-appeals', ensureAuth(), async (req, res) => {
  try {
    await ensureReportsTables()
    const { status } = req.query || {}
    const meArr = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    if (!meArr.length) return res.status(403).json({ error: 'Unauthorized' })
    const me = meArr[0]
    let rows = await db.select().from(reportAppealsTable)
    rows = rows.filter(a => a.userId === me.id)
    if (status) rows = rows.filter(a => String(a.status) === String(status))
    // Sort newest first
    rows.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))
    return res.json({ items: rows })
  } catch (e) {
    console.error('my-appeals failed', e)
    return res.status(500).json({ error: 'Failed to fetch appeals' })
  }
})

export default router
