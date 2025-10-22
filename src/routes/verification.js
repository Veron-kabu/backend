import { Router } from 'express'
import { ensureAuth, clerkClient, getAuth } from '../middleware/auth.js'
import { ENV } from '../config/env.js'
import fs from 'fs'
import path from 'path'
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { db } from '../config/db.js'
import { usersTable, userVerificationTable, verificationSubmissionsTable, uploadTokensTable, auditLogsTable, verificationStatusHistoryTable, userNotificationsTable, verificationAppealsTable } from '../db/schema.js'
import { eq, desc, inArray } from 'drizzle-orm'
import { takeToken } from '../utils/rateLimit.js'
import { writeAudit } from '../utils/audit.js'
import { createNotification, listUserNotifications, markNotificationRead, deleteNotification } from '../utils/notifications.js'
import { writeStatusHistory } from '../utils/statusHistory.js'
import { sendEmail, renderStatusEmail } from '../utils/email.js'

// In-memory stores removed; persisted in DB

const VER_DIR = path.join(process.cwd(), 'data', 'verification-uploads')
fs.mkdirSync(VER_DIR, { recursive: true })

const router = Router()

// Removed verification code issuance. Codes and automated analysis are no longer used for submissions.

// POST /verification/upload-token -> { uploadUrl, uploadKey, publicUrl? }
router.post('/verification/upload-token', ensureAuth(), async (req, res) => {
  try {
    // Rate limit: burst 30, ~0.5 token/sec
    const rlKey = `${req.auth.userId}:verif:upload-token`
    const ok = takeToken(rlKey, { capacity: 30, refillRatePerSec: 0.5 })
    if (!ok) return res.status(429).json({ error: 'rate_limited' })
    const { filename = `capture_${Date.now()}.jpg`, contentType = 'image/jpeg', noAcl = false } = req.body || {}
  const { AWS_S3_BUCKET, AWS_S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_CLOUDFRONT_DOMAIN, AWS_S3_VERIFICATION_PREFIX } = ENV
    const s3Configured = !!(AWS_S3_BUCKET && AWS_S3_REGION && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY)
    if (!s3Configured) return res.status(501).json({ error: 'upload-token not supported' })
    const rawPrefix = AWS_S3_VERIFICATION_PREFIX || 'verification/'
    const cleanPrefix = String(rawPrefix).replace(/^\/+/, '').replace(/\/+$/, '')
    const objectKey = `${cleanPrefix}/${req.auth.userId}/${Date.now()}_${filename}`
    const s3 = new S3Client({ region: AWS_S3_REGION, credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } })
  // Always omit ACLs for verification uploads to support buckets with Object Ownership enforced (no ACLs allowed)
  const acl = undefined
  // Do not include ContentType in the presign to avoid header-mismatch 400s from some mobile uploaders
  const cmd = new PutObjectCommand({ Bucket: AWS_S3_BUCKET, Key: objectKey, ACL: acl })
    const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 600 })
    const publicUrl = AWS_CLOUDFRONT_DOMAIN
      ? `https://${AWS_CLOUDFRONT_DOMAIN}/${objectKey}`
      : `https://${AWS_S3_BUCKET}.s3.${AWS_S3_REGION}.amazonaws.com/${objectKey}`
    const originUrl = `https://${AWS_S3_BUCKET}.s3.${AWS_S3_REGION}.amazonaws.com/${objectKey}`
    const body = { uploadUrl, uploadKey: objectKey, publicUrl: undefined, originUrl, contentType }
    // Record expected upload key in DB (expires in 10 minutes)
    try {
      const uRows = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
      if (uRows.length) {
        await db.insert(uploadTokensTable).values({ userId: uRows[0].id, uploadKey: objectKey, contentType, expiresAt: new Date(Date.now() + 10*60*1000) })
      }
    } catch {}
  // Audit
  try { await writeAudit(db, { actorUserId: req.auth.userId, action: 'upload_token_issued', subjectType: 's3_object', subjectId: objectKey, details: { contentType } }) } catch {}
  return res.json(body)
  } catch (e) {
    console.error('upload-token error', e)
    return res.status(500).json({ error: 'failed' })
  }
})

// Optional: POST /verification/upload (multipart) for local fallback
router.post('/verification/upload', ensureAuth(), async (req, res) => {
  try {
    // Expect multipart form-data with a single file field named 'file'
    // For simplicity in MVP without multer, accept raw body not ideal. Recommend adding multer in future.
    // Here we reject with 501 to indicate not implemented unless you wire multer.
    return res.status(501).json({ error: 'direct upload not implemented on server' })
  } catch (e) {
    console.error('direct upload error', e)
    return res.status(500).json({ error: 'failed' })
  }
})

// POST /verification/submission
router.post('/verification/submission', ensureAuth(), async (req, res) => {
  try {
    // Rate limit: burst 5, ~0.1 token/sec
    const key = `${req.auth.userId}:verif:submit`
    const ok = takeToken(key, { capacity: 5, refillRatePerSec: 0.1 })
    if (!ok) return res.status(429).json({ error: 'rate_limited' })
    const { images: imagesRaw = [], device_info } = req.body || {}
    if (!Array.isArray(imagesRaw) || imagesRaw.length < 1) return res.status(400).json({ error: 'invalid payload' })
  // Enforce maximum of 3 photos on server as a safeguard (client already limits)
    const images = imagesRaw.slice(0, 3)
    // Resolve DB user id
    const meRows = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    if (meRows.length === 0) return res.status(404).json({ error: 'user not found' })
    const me = meRows[0]

  // Minimal checks; verify uploaded objects exist and capture metadata (etag/size/type)
    const dbUser = me
    const now = new Date()
    // Verify S3 objects (if S3 configured) and basic metadata; no OCR/EXIF/classification/scoring
    let enhancedImages = images
    const { AWS_S3_BUCKET, AWS_S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } = ENV
    const canHead = !!(AWS_S3_BUCKET && AWS_S3_REGION && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY)
    if (canHead && Array.isArray(images) && images.length) {
      const s3 = new S3Client({ region: AWS_S3_REGION, credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } })
      enhancedImages = await Promise.all(images.map(async (img) => {
        const uploadKey = img?.uploadKey
        if (!uploadKey) return { ...img, verified: false }
        // Validate uploadKey against upload_tokens (same user, not expired), then mark consumed
        try {
          const tokenRows = await db.select().from(uploadTokensTable).where(eq(uploadTokensTable.uploadKey, uploadKey))
          const token = tokenRows[0]
          if (!token || token.userId !== me.id || (token.expiresAt && new Date() > new Date(token.expiresAt))) {
            return { ...img, verified: false, tokenValid: false }
          }
          // consume token
          try { await db.delete(uploadTokensTable).where(eq(uploadTokensTable.id, token.id)) } catch {}
        } catch {}
        // HEAD object to capture size/type if available
        try {
          const head = await s3.send(new HeadObjectCommand({ Bucket: AWS_S3_BUCKET, Key: uploadKey }))
          return { ...img, verified: true, etag: head.ETag || null, size: head.ContentLength ?? null, contentType: head.ContentType || null }
        } catch {
          return { ...img, verified: false }
        }
      }))
    }
  // No auto-flagging or scoring
  const status = 'pending'
    // Insert submission into DB
    const inserted = await db.insert(verificationSubmissionsTable).values({
      userId: dbUser.id,
      images: enhancedImages,
      deviceInfo: device_info || null,
      status,
      createdAt: now,
      updatedAt: now,
    }).returning()

    // Upsert user verification to pending
    const existingVer = await db.select().from(userVerificationTable).where(eq(userVerificationTable.userId, dbUser.id))
    if (existingVer.length === 0) {
      await db.insert(userVerificationTable).values({ userId: dbUser.id, status: 'pending', updatedAt: now })
    } else {
      await db.update(userVerificationTable).set({ status: 'pending', updatedAt: now }).where(eq(userVerificationTable.userId, dbUser.id))
    }
    // Audit
    try { await writeAudit(db, { actorUserId: req.auth.userId, action: 'verification_submitted', subjectType: 'verification', subjectId: inserted[0].id, details: { imagesCount: enhancedImages.length } }) } catch {}
  // History
  try { await writeStatusHistory(db, { submissionId: inserted[0].id, fromStatus: null, toStatus: status, actorUserId: me.id }) } catch {}
    return res.json({ submissionId: inserted[0].id, status: 'pending' })
  } catch (e) {
    console.error('submission error', e)
    return res.status(500).json({ error: 'failed' })
  }
})

// GET /verification/:id/status -> { id, status }
router.get('/verification/:id/status', ensureAuth(), async (req, res) => {
  try {
    const idNum = Number(req.params.id)
    if (isNaN(idNum)) return res.status(400).json({ error: 'invalid id' })
    // Resolve current user
    const meRows = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    if (meRows.length === 0) return res.status(404).json({ error: 'user not found' })
    const me = meRows[0]
    const rows = await db.select().from(verificationSubmissionsTable).where(eq(verificationSubmissionsTable.id, idNum))
    if (rows.length === 0) return res.status(404).json({ error: 'not found' })
    const rec = rows[0]
    if (rec.userId !== me.id) return res.status(403).json({ error: 'forbidden' })
    return res.json({ id: rec.id, status: rec.status })
  } catch (e) {
    return res.status(500).json({ error: 'failed' })
  }
})

// Admin: verification config (thresholds)
// Automated scoring, duplicate detection, and configuration have been removed.

// GET /verification/my-status -> { status }
router.get('/verification/my-status', ensureAuth(), async (req, res) => {
  try {
    // Resolve DB user
    const userRows = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    if (userRows.length === 0) return res.json({ status: 'unverified' })
    const dbUser = userRows[0]
    // Prefer deriving from the latest submission state for accuracy
    let latest = null
    try {
      const allSubs = await db.select().from(verificationSubmissionsTable)
      latest = allSubs.filter(r => r.userId === dbUser.id).sort((a,b)=> new Date(b.createdAt) - new Date(a.createdAt))[0] || null
    } catch {}
    if (latest) {
      // Map submission status to user-level status
      const s = String(latest.status)
      const status = (s === 'approved') ? 'verified'
        : (s === 'rejected') ? 'rejected'
        : /* flagged, pending, awaiting_second_approval, appeal, reinstated */ 'pending'
      return res.json({ status })
    }
    // Fallback to userVerificationTable if no submissions exist yet
    const rows = await db.select().from(userVerificationTable).where(eq(userVerificationTable.userId, dbUser.id))
    const status = rows[0]?.status || 'unverified'
    return res.json({ status })
  } catch (e) {
    return res.status(500).json({ error: 'failed' })
  }
})

// User: fetch latest submission details with visible admin comments and history
router.get('/verification/my-latest', ensureAuth(), async (req, res) => {
  try {
    const meRows = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    if (!meRows.length) return res.status(404).json({ error: 'user not found' })
    const me = meRows[0]
    const all = await db.select().from(verificationSubmissionsTable)
    const mine = all.filter(r => r.userId === me.id).sort((a,b)=> new Date(b.createdAt) - new Date(a.createdAt))
    const r = mine[0]
    if (!r) return res.json(null)
    // Visible comments only
    const adminComments = (Array.isArray(r.adminComments) ? r.adminComments : []).filter(c => c && c.visibleToUser)
    // Determine a reviewer message to show to the user
    let reviewerMessage = null
    try {
      const sorted = [...adminComments].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))
      if (sorted.length && sorted[0]?.text) reviewerMessage = String(sorted[0].text)
    } catch {}
    let history = []
    try { history = await db.select().from(verificationStatusHistoryTable); history = history.filter(h => h.submissionId === r.id).sort((a,b)=> new Date(a.createdAt) - new Date(b.createdAt)) } catch {}
    return res.json({ id: r.id, status: r.status, adminComments, history, reviewerMessage })
  } catch (e) {
    return res.status(500).json({ error: 'failed' })
  }
})

function requireAdmin(req, res, next) {
  const { userId } = req.auth || {}
  if (!userId) return res.status(401).json({ error: 'unauthorized' })
  ;(async () => {
    try {
      const u = await clerkClient.users.getUser(userId)
      const role = u?.unsafeMetadata?.role
      if (role !== 'admin') return res.status(403).json({ error: 'forbidden' })
      return next()
    } catch (e) {
      console.error('admin check error', e)
      return res.status(500).json({ error: 'failed' })
    }
  })()
}

// Admin: signed URL resolver for verification images (no direct S3 link)
router.get('/admin/verification-image-url', ensureAuth(), requireAdmin, async (req, res) => {
  try {
    const { key } = req.query || {}
    if (!key) return res.status(400).json({ error: 'missing key' })
    const { AWS_S3_BUCKET, AWS_S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } = ENV
    if (!AWS_S3_BUCKET || !AWS_S3_REGION || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
      return res.status(501).json({ error: 's3 not configured' })
    }
    const s3 = new S3Client({ region: AWS_S3_REGION, credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } })
    const cmd = new GetObjectCommand({ Bucket: AWS_S3_BUCKET, Key: String(key) })
    const url = await getSignedUrl(s3, cmd, { expiresIn: 300 })
    try { await writeAudit(db, { actorUserId: req.auth.userId, action: 'admin_signed_get', subjectType: 's3_object', subjectId: String(key), details: {} }) } catch {}
    return res.json({ url })
  } catch (e) {
    return res.status(500).json({ error: 'failed' })
  }
})

// Admin: Audit logs list (lightweight)
router.get('/admin/audit-logs', ensureAuth(), requireAdmin, async (req, res) => {
  try {
    const { limit = 100, since, action } = req.query || {}
    let rows = await db.select().from(auditLogsTable).orderBy(desc(auditLogsTable.createdAt))
    if (since) rows = rows.filter(r => new Date(r.createdAt) >= new Date(since))
    if (action) rows = rows.filter(r => String(r.action) === String(action))
    const out = rows.slice(0, Math.max(1, Math.min(500, Number(limit))))
    return res.json({ items: out })
  } catch (e) {
    return res.status(500).json({ error: 'failed' })
  }
})

// Admin: Audit logs CSV export
router.get('/admin/audit-logs.csv', ensureAuth(), requireAdmin, async (req, res) => {
  try {
    const { limit = 1000, since, action } = req.query || {}
    let rows = await db.select().from(auditLogsTable).orderBy(desc(auditLogsTable.createdAt))
    if (since) rows = rows.filter(r => new Date(r.createdAt) >= new Date(since))
    if (action) rows = rows.filter(r => String(r.action) === String(action))
    const out = rows.slice(0, Math.max(1, Math.min(5000, Number(limit))))
    const header = ['createdAt','actorUserId','action','subjectType','subjectId','details']
    const csv = [header.join(',')]
    for (const r of out) {
      const row = [
        new Date(r.createdAt).toISOString(),
        r.actorUserId ?? '',
        r.action ?? '',
        r.subjectType ?? '',
        r.subjectId ?? '',
        JSON.stringify(r.details ?? {}),
      ]
      // simple CSV escaping for commas/quotes
      csv.push(row.map(v => {
        const s = String(v)
        return (s.includes(',') || s.includes('"') || s.includes('\n')) ? '"' + s.replace(/"/g, '""') + '"' : s
      }).join(','))
    }
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', 'attachment; filename="audit-logs.csv"')
    return res.send(csv.join('\n'))
  } catch (e) {
    return res.status(500).json({ error: 'failed' })
  }
})

// Admin: list submissions
router.get('/admin/verifications', ensureAuth(), requireAdmin, async (req, res) => {
  try {
    // Disable caching for admin lists so new decisions show up immediately
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')
  // Optional filters: status, user_id, since, until, duplicate, max_score
  const { status, user_id, since, until } = req.query || {}
    let base = db.select().from(verificationSubmissionsTable)
    // Note: drizzle-orm doesn't support dynamic chaining elegantly here without sql tagged templates.
    // We'll filter in JS after fetch as a safe fallback for MVP scale.
    const rowsRaw = await base.orderBy(desc(verificationSubmissionsTable.createdAt))
    const rows = rowsRaw.filter(r => {
      if (status && String(r.status) !== String(status)) return false
      if (user_id && String(r.userId) !== String(user_id)) return false
      if (since && new Date(r.createdAt) < new Date(since)) return false
      if (until && new Date(r.createdAt) > new Date(until)) return false
      return true
    })
    // Fetch users to map email by id for display purposes
  const userIds = Array.from(new Set(rows.map(r => r.userId).filter(Boolean)))
  const users = userIds.length ? await db.select().from(usersTable).where(inArray(usersTable.id, userIds)) : []
    const emailById = new Map(users.map(u => [u.id, u.email]))
    const items = rows.map(r => {
      const images = Array.isArray(r.images) ? r.images : []
      const enhanced = images.map(img => {
        const hasUrl = !!img?.url
        let displayUrl = img?.url || null
        if (!hasUrl && ENV.AWS_S3_PUBLIC_READ && ENV.AWS_S3_BUCKET && ENV.AWS_S3_REGION && img?.uploadKey) {
          displayUrl = ENV.AWS_CLOUDFRONT_DOMAIN
            ? `https://${ENV.AWS_CLOUDFRONT_DOMAIN}/${img.uploadKey}`
            : `https://${ENV.AWS_S3_BUCKET}.s3.${ENV.AWS_S3_REGION}.amazonaws.com/${img.uploadKey}`
        }
        // For private buckets, still attach an origin URL; client will resolve via resolver
        if (!hasUrl && !displayUrl && img?.uploadKey && ENV.AWS_S3_BUCKET && ENV.AWS_S3_REGION) {
          displayUrl = `https://${ENV.AWS_S3_BUCKET}.s3.${ENV.AWS_S3_REGION}.amazonaws.com/${img.uploadKey}`
        }
        return { ...img, displayUrl }
      })
      return {
        id: r.id,
        userId: r.userId,
        userEmail: emailById.get(r.userId) || null,
        status: r.status,
        awaitingSecondApproval: r.status === 'awaiting_second_approval',
        firstReviewerId: r.reviewerId || null,
        deviceInfo: r.deviceInfo,
        images: enhanced,
  // imageReviews removed from API output
        autoChecks: null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }
    })
    return res.json({ items })
  } catch (e) {
    return res.status(500).json({ error: 'failed' })
  }
})

// Admin: get single submission with user details
router.get('/admin/verifications/:id', ensureAuth(), requireAdmin, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')
    const idNum = Number(req.params.id)
    if (isNaN(idNum)) return res.status(400).json({ error: 'invalid id' })
    const rows = await db.select().from(verificationSubmissionsTable).where(eq(verificationSubmissionsTable.id, idNum))
    if (rows.length === 0) return res.status(404).json({ error: 'not found' })
    const r = rows[0]
    const images = Array.isArray(r.images) ? r.images : []
    const enhanced = images.map(img => {
      const hasUrl = !!img?.url
      let displayUrl = img?.url || null
      if (!hasUrl && ENV.AWS_S3_PUBLIC_READ && ENV.AWS_S3_BUCKET && ENV.AWS_S3_REGION && img?.uploadKey) {
        displayUrl = ENV.AWS_CLOUDFRONT_DOMAIN
          ? `https://${ENV.AWS_CLOUDFRONT_DOMAIN}/${img.uploadKey}`
          : `https://${ENV.AWS_S3_BUCKET}.s3.${ENV.AWS_S3_REGION}.amazonaws.com/${img.uploadKey}`
      }
      if (!hasUrl && !displayUrl && img?.uploadKey && ENV.AWS_S3_BUCKET && ENV.AWS_S3_REGION) {
        displayUrl = `https://${ENV.AWS_S3_BUCKET}.s3.${ENV.AWS_S3_REGION}.amazonaws.com/${img.uploadKey}`
      }
      return { ...img, displayUrl }
    })
    // Attach user details
    const uRows = await db.select().from(usersTable).where(eq(usersTable.id, r.userId))
    const user = uRows[0] || null
      // Fetch history
      let history = []
      try {
        history = await db.select().from(verificationStatusHistoryTable)
        history = history.filter(h => h.submissionId === r.id).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt))
      } catch {}
  return res.json({
      id: r.id,
      userId: r.userId,
      user: user ? {
        id: user.id,
        email: user.email,
        username: user.username,
        full_name: user.fullName,
        phone: user.phone,
        role: user.role,
        status: user.status,
        profile_image_url: user.profileImageUrl,
        banner_image_url: user.bannerImageUrl,
        created_at: user.createdAt,
      } : null,
      status: r.status,
      deviceInfo: r.deviceInfo,
      images: enhanced,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
  // imageReviews removed from API output
      autoChecks: null,
      adminComments: r.adminComments || [],
      awaitingSecondApproval: r.status === 'awaiting_second_approval',
      firstReviewerId: r.reviewerId || null,
      history,
    })
  } catch (e) {
    return res.status(500).json({ error: 'failed' })
  }
})

// Admin: approve
router.post('/admin/verifications/:id/approve', ensureAuth(), requireAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const reviewer = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    const rows = await db.select().from(verificationSubmissionsTable).where(eq(verificationSubmissionsTable.id, Number(id)))
    if (rows.length === 0) return res.status(404).json({ error: 'not found' })
    const rec = rows[0]
    const now = new Date()
    // Single-admin approval flow
    await db.update(verificationSubmissionsTable).set({ status: 'approved', reviewerId: reviewer?.[0]?.id || null, reviewerId2: null, updatedAt: now }).where(eq(verificationSubmissionsTable.id, rec.id))
    await db
      .insert(userVerificationTable)
      .values({ userId: rec.userId, status: 'verified', updatedAt: now })
      .onConflictDoUpdate({ target: userVerificationTable.userId, set: { status: 'verified', updatedAt: now } })
    try { await db.update(usersTable).set({ farmVerified: true, updatedAt: now }).where(eq(usersTable.id, rec.userId)) } catch {}
    try { await writeAudit(db, { actorUserId: req.auth.userId, action: 'verification_approved', subjectType: 'verification', subjectId: rec.id, details: {} }) } catch {}
    try { await writeStatusHistory(db, { submissionId: rec.id, fromStatus: rec.status, toStatus: 'approved', actorUserId: reviewer?.[0]?.id }) } catch {}
    // Notify user (in-app)
    try { await createNotification(db, { userId: rec.userId, type: 'verification_status', title: 'Verification approved', body: 'Your farm verification was approved. You now have verified status.', data: { submissionId: rec.id, status: 'approved' } }) } catch {}
    // Email (optional)
    try {
      const u = await db.select().from(usersTable).where(eq(usersTable.id, rec.userId))
      const email = u?.[0]?.email
      if (email) {
        const { subject, text, html } = renderStatusEmail({ status: 'approved', submissionId: rec.id })
        await sendEmail({ to: email, subject, text, html })
      }
    } catch {}
    return res.json({ ok: true, submission: { ...rec, status: 'approved', updatedAt: now } })
  } catch (e) {
    return res.status(500).json({ error: 'failed' })
  }
})

// Admin: reject
router.post('/admin/verifications/:id/reject', ensureAuth(), requireAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const { reviewer_comment } = req.body || {}
    const reviewer = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    const rows = await db.select().from(verificationSubmissionsTable).where(eq(verificationSubmissionsTable.id, Number(id)))
    if (rows.length === 0) return res.status(404).json({ error: 'not found' })
    const rec = rows[0]
    const now = new Date()
    await db.update(verificationSubmissionsTable).set({ status: 'rejected', reviewerId: reviewer?.[0]?.id || null, reviewComment: reviewer_comment || null, updatedAt: now }).where(eq(verificationSubmissionsTable.id, rec.id))
    await db
      .insert(userVerificationTable)
      .values({ userId: rec.userId, status: 'rejected', updatedAt: now })
      .onConflictDoUpdate({ target: userVerificationTable.userId, set: { status: 'rejected', updatedAt: now } })
    try { await writeAudit(db, { actorUserId: req.auth.userId, action: 'verification_rejected', subjectType: 'verification', subjectId: rec.id, details: {} }) } catch {}
    try { await writeStatusHistory(db, { submissionId: rec.id, fromStatus: rec.status, toStatus: 'rejected', actorUserId: reviewer?.[0]?.id, note: reviewer_comment }) } catch {}
    // Notify user (in-app)
  try { await createNotification(db, { userId: rec.userId, type: 'verification_status', title: 'Verification rejected', body: reviewer_comment ? `Reason: ${reviewer_comment}` : 'Your verification was rejected. You can resubmit with clearer photos.', data: { submissionId: rec.id, status: 'rejected' } }) } catch {}
    try {
      const u = await db.select().from(usersTable).where(eq(usersTable.id, rec.userId))
      const email = u?.[0]?.email
      if (email) {
        const { subject, text, html } = renderStatusEmail({ status: 'rejected', reason: reviewer_comment, submissionId: rec.id })
        await sendEmail({ to: email, subject, text, html })
      }
    } catch {}
    return res.json({ ok: true, submission: { ...rec, status: 'rejected', updatedAt: now } })
  } catch (e) {
    return res.status(500).json({ error: 'failed' })
  }
})

// Admin per-image tagging removed: no endpoint for image-specific note/decision.

// Admin: request more info
router.post('/admin/verifications/:id/request-more-info', ensureAuth(), requireAdmin, async (req, res) => {
  try {
  const { id } = req.params
  const { reason } = req.body || {}
    const rows = await db.select().from(verificationSubmissionsTable).where(eq(verificationSubmissionsTable.id, Number(id)))
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    const rec = rows[0]
    // Mark as flagged; use adminComments/history for guidance (no imageReviews)
    const now = new Date()
    let adminComments = Array.isArray(rec.adminComments) ? [...rec.adminComments] : []
    if (reason && String(reason).trim().length) {
      adminComments.push({ text: String(reason), visibleToUser: true, reviewerUserId: req.auth.userId, createdAt: now.toISOString() })
    }
    await db.update(verificationSubmissionsTable).set({ status: 'flagged', updatedAt: now, adminComments }).where(eq(verificationSubmissionsTable.id, rec.id))
    // Ensure user verification overall status reflects that user can respond (pending)
    try {
      await db
        .insert(userVerificationTable)
        .values({ userId: rec.userId, status: 'pending', updatedAt: now })
        .onConflictDoUpdate({ target: userVerificationTable.userId, set: { status: 'pending', updatedAt: now } })
    } catch {}
    try { await writeAudit(db, { actorUserId: req.auth.userId, action: 'verification_request_more_info', subjectType: 'verification', subjectId: rec.id, details: { reason } }) } catch {}
  try { await writeStatusHistory(db, { submissionId: rec.id, fromStatus: rec.status, toStatus: 'flagged', actorUserId: req.auth.userId, note: reason }) } catch {}
    // Notify user
    try { await createNotification(db, { userId: rec.userId, type: 'verification_status', title: 'More info requested', body: reason ? `Reviewer note: ${reason}` : 'Please provide more information or clearer photos for your verification.', data: { submissionId: rec.id, status: 'flagged' } }) } catch {}
    try {
      const u = await db.select().from(usersTable).where(eq(usersTable.id, rec.userId))
      const email = u?.[0]?.email
      if (email) {
        const { subject, text, html } = renderStatusEmail({ status: 'flagged', reason, submissionId: rec.id })
        await sendEmail({ to: email, subject, text, html })
      }
    } catch {}
    return res.json({ ok: true })
  } catch (e) {
    return res.status(500).json({ error: 'failed' })
  }
})

// Admin escalate endpoint removed per product decision; use request-more-info or reject instead

// Admin: add structured comment
router.post('/admin/verifications/:id/comment', ensureAuth(), requireAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const { text, visible_to_user } = req.body || {}
    const rows = await db.select().from(verificationSubmissionsTable).where(eq(verificationSubmissionsTable.id, Number(id)))
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    const rec = rows[0]
    const comments = Array.isArray(rec.adminComments) ? [...rec.adminComments] : []
    comments.push({ text: String(text || ''), visibleToUser: !!visible_to_user, reviewerUserId: req.auth.userId, createdAt: new Date().toISOString() })
    await db.update(verificationSubmissionsTable).set({ adminComments: comments, updatedAt: new Date() }).where(eq(verificationSubmissionsTable.id, rec.id))
    await writeAudit(db, { actorUserId: req.auth.userId, action: 'verification_comment_added', subjectType: 'verification', subjectId: rec.id, details: { visible_to_user: !!visible_to_user } })
    return res.json({ ok: true, adminComments: comments })
  } catch (e) {
    return res.status(500).json({ error: 'failed' })
  }
})

// Admin re-check endpoint removed: automated OCR/EXIF/classification/duplicate/score checks are no longer supported.

// User: file an appeal
router.post('/verification/:id/appeal', ensureAuth(), async (req, res) => {
  try {
    const idNum = Number(req.params.id)
    const { reason } = req.body || {}
    if (isNaN(idNum)) return res.status(400).json({ error: 'invalid id' })
    const meRows = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    if (!meRows.length) return res.status(404).json({ error: 'user not found' })
    const me = meRows[0]
    const rows = await db.select().from(verificationSubmissionsTable).where(eq(verificationSubmissionsTable.id, idNum))
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    const rec = rows[0]
    if (rec.userId !== me.id) return res.status(403).json({ error: 'forbidden' })
    // Extend retention by +60 days default
    const extendMs = 60 * 24 * 60 * 60 * 1000
    const until = new Date(Date.now() + extendMs)
    await db.update(verificationSubmissionsTable).set({ retentionExtendedUntil: until, updatedAt: new Date() }).where(eq(verificationSubmissionsTable.id, rec.id))
    const appeal = await db.insert(verificationAppealsTable).values({ submissionId: rec.id, userId: me.id, reason: reason || null, status: 'open', priority: 2, retentionExtendedUntil: until }).returning()
    await writeAudit(db, { actorUserId: req.auth.userId, action: 'verification_appeal_created', subjectType: 'verification', subjectId: rec.id, details: { reason } })
    // Move to 'appeal' status for rejected or flagged cases
    if (rec.status === 'rejected' || rec.status === 'flagged') {
      await db.update(verificationSubmissionsTable).set({ status: 'appeal', updatedAt: new Date() }).where(eq(verificationSubmissionsTable.id, rec.id))
      try { await writeStatusHistory(db, { submissionId: rec.id, fromStatus: rec.status, toStatus: 'appeal', actorUserId: me.id, note: reason }) } catch {}
    }
    // Notify admins via audit only (no email in this MVP)
    return res.json({ ok: true, appeal: appeal?.[0] || null })
  } catch (e) {
    return res.status(500).json({ error: 'failed' })
  }
})

// User: provide additional evidence for a flagged submission
// body: { images: [{ uploadKey, lat, lng, accuracy, altitude, altitude_accuracy, timestamp, photo_index, url }] }
router.post('/verification/:id/respond-more', ensureAuth(), async (req, res) => {
  try {
    const idNum = Number(req.params.id)
    if (isNaN(idNum)) return res.status(400).json({ error: 'invalid id' })
    const meRows = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    if (!meRows.length) return res.status(404).json({ error: 'user not found' })
    const me = meRows[0]
    const rows = await db.select().from(verificationSubmissionsTable).where(eq(verificationSubmissionsTable.id, idNum))
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    const rec = rows[0]
    if (rec.userId !== me.id) return res.status(403).json({ error: 'forbidden' })
    if (rec.status !== 'flagged' && rec.status !== 'appeal' && rec.status !== 'pending' && rec.status !== 'awaiting_second_approval') {
      return res.status(400).json({ error: 'respond_not_allowed_for_status' })
    }

  // Require exactly 3 photos in respond-more
  const images = Array.isArray(req.body?.images) ? req.body.images.slice(0, 3) : []
    if (images.length < 3) return res.status(400).json({ error: 'need_exactly_3_images' })
    const userNote = typeof req.body?.note === 'string' ? req.body.note.trim() : ''
    if (!images.length) return res.status(400).json({ error: 'no_images' })

    const { AWS_S3_BUCKET, AWS_S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } = ENV
    const canHead = !!(AWS_S3_BUCKET && AWS_S3_REGION && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY)
    let enhanced = images
    if (canHead) {
      const s3 = new S3Client({ region: AWS_S3_REGION, credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } })
      enhanced = await Promise.all(images.map(async (img) => {
        const uploadKey = img?.uploadKey
        if (!uploadKey) return { ...img, verified: false }
        // Validate and consume upload token
        try {
          const tokenRows = await db.select().from(uploadTokensTable).where(eq(uploadTokensTable.uploadKey, uploadKey))
          const token = tokenRows[0]
          if (!token || token.userId !== me.id || (token.expiresAt && new Date() > new Date(token.expiresAt))) {
            return { ...img, verified: false, tokenValid: false }
          }
          try { await db.delete(uploadTokensTable).where(eq(uploadTokensTable.id, token.id)) } catch {}
        } catch {}
        // HEAD object for metadata
        try {
          const head = await s3.send(new HeadObjectCommand({ Bucket: AWS_S3_BUCKET, Key: uploadKey }))
          return { ...img, verified: true, etag: head.ETag || null, size: head.ContentLength ?? null, contentType: head.ContentType || null }
        } catch {
          return { ...img, verified: false }
        }
      }))
    }

    // Merge images (existing + enhanced)
    const now = new Date()
    const mergedImages = [...(Array.isArray(rec.images) ? rec.images : []), ...enhanced]

    // No automated checks on respond-more
  let statusNext = rec.status
  // When user responds to a flagged submission, move it back to pending for re-review
  if (rec.status === 'flagged') {
    statusNext = 'pending'
  }

    // Optionally append user note into adminComments
    let adminComments = Array.isArray(rec.adminComments) ? [...rec.adminComments] : []
    if (userNote) {
      adminComments.push({
        text: userNote,
        fromUser: true,
        visibleToUser: true,
        reviewerUserId: null,
        createdAt: now.toISOString(),
      })
    }

  await db.update(verificationSubmissionsTable).set({ images: mergedImages, status: statusNext, updatedAt: now, adminComments }).where(eq(verificationSubmissionsTable.id, rec.id))
  try { await writeStatusHistory(db, { submissionId: rec.id, fromStatus: rec.status, toStatus: statusNext, actorUserId: me.id, note: 'user provided additional info' }) } catch {}
  try { await writeAudit(db, { actorUserId: req.auth.userId, action: 'verification_respond_more', subjectType: 'verification', subjectId: rec.id, details: { added: enhanced.length, note: !!userNote } }) } catch {}
    // Keep userVerificationTable as pending
    try {
      await db
        .insert(userVerificationTable)
        .values({ userId: rec.userId, status: 'pending', updatedAt: now })
        .onConflictDoUpdate({ target: userVerificationTable.userId, set: { status: 'pending', updatedAt: now } })
    } catch {}
    // Notify user for confirmation and optionally admins via audit dashboard
    try { await createNotification(db, { userId: rec.userId, type: 'verification_status', title: 'Additional info submitted', body: 'Thanks! We received your additional information. We\'ll review it shortly.', data: { submissionId: rec.id, status: 'pending' } }) } catch {}

  return res.json({ ok: true, submissionId: rec.id, status: statusNext })
  } catch (e) {
    return res.status(500).json({ error: 'failed' })
  }
})

// Admin: list appeals (simple)
router.get('/admin/verification-appeals', ensureAuth(), requireAdmin, async (req, res) => {
  try {
    const { status = 'open' } = req.query || {}
    const all = await db.select().from(verificationAppealsTable)
    const items = all.filter(a => !status || String(a.status) === String(status))
    return res.json({ items })
  } catch (e) {
    return res.status(500).json({ error: 'failed' })
  }
})

// Admin: resolve appeal (reinstated optional)
router.post('/admin/verification-appeals/:id/resolve', ensureAuth(), requireAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const { resolution_note, reinstate } = req.body || {}
    const rows = await db.select().from(verificationAppealsTable).where(eq(verificationAppealsTable.id, Number(id)))
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    const appeal = rows[0]
    const now = new Date()
    await db.update(verificationAppealsTable).set({ status: 'resolved', resolvedAt: now, resolverUserId: req.auth.userId, resolutionNote: resolution_note || null }).where(eq(verificationAppealsTable.id, appeal.id))
    // Optionally reinstate submission
    if (reinstate) {
      const subRows = await db.select().from(verificationSubmissionsTable).where(eq(verificationSubmissionsTable.id, appeal.submissionId))
      const rec = subRows?.[0]
      if (rec) {
        await db.update(verificationSubmissionsTable).set({ status: 'reinstated', updatedAt: now }).where(eq(verificationSubmissionsTable.id, rec.id))
        await writeStatusHistory(db, { submissionId: rec.id, fromStatus: rec.status, toStatus: 'reinstated', actorUserId: req.auth.userId, note: resolution_note })
      }
    }
    await writeAudit(db, { actorUserId: req.auth.userId, action: 'verification_appeal_resolved', subjectType: 'appeal', subjectId: appeal.id, details: { reinstate: !!reinstate } })
    return res.json({ ok: true })
  } catch (e) {
    return res.status(500).json({ error: 'failed' })
  }
})

// User notifications: list and mark-read
router.get('/verification/my-notifications', ensureAuth(), async (req, res) => {
  try {
    const meRows = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    if (!meRows.length) return res.status(404).json({ error: 'user not found' })
    const me = meRows[0]
    // Return only unread by default so read items do not reappear
    const items = await listUserNotifications(db, me.id, { limit: 100, includeRead: false })
    return res.json({ items })
  } catch (e) {
    return res.status(500).json({ error: 'failed' })
  }
})

router.post('/verification/notifications/:id/read', ensureAuth(), async (req, res) => {
  try {
    const meRows = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    if (!meRows.length) return res.status(404).json({ error: 'user not found' })
    const me = meRows[0]
    const updated = await markNotificationRead(db, Number(req.params.id), me.id)
    if (!updated) return res.status(404).json({ error: 'not found' })
    return res.json({ ok: true, readAt: updated.readAt })
  } catch (e) {
    return res.status(500).json({ error: 'failed' })
  }
})

// Delete a notification permanently
router.post('/verification/notifications/:id/delete', ensureAuth(), async (req, res) => {
  try {
    const meRows = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    if (!meRows.length) return res.status(404).json({ error: 'user not found' })
    const me = meRows[0]
    const removed = await deleteNotification(db, Number(req.params.id), me.id)
    if (!removed) return res.status(404).json({ error: 'not found' })
    return res.json({ ok: true, removed: true })
  } catch (e) {
    return res.status(500).json({ error: 'failed' })
  }
})

export default router
