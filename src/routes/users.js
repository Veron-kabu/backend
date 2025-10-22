import { Router } from 'express'
import express from 'express'
import { db } from '../config/db.js'
import { usersTable, ordersTable, orderStatusHistoryTable } from '../db/schema.js'
import { ensureAuth, clerkClient } from '../middleware/auth.js'
import { handleUserCreated } from './webhooks.js'
import { requireRole } from '../middleware/role.js'
import { ENV } from '../config/env.js'
import { eq, and, or, inArray, desc } from 'drizzle-orm'
import { createNotification } from '../utils/notifications.js'
import { requireNotSuspended } from '../middleware/status.js'

const router = Router()

// Note: server.js skips global JSON parser for /api/users/profile to allow larger bodies.
// Apply JSON parsing only to routes that actually need it (e.g., PATCH), not for GET.

// Create user
router.post('/users', ensureAuth(), async (req, res) => {
  try {
    const existingUser = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    if (existingUser.length > 0) return res.json(existingUser[0])
    const { username, email, role, full_name, phone, location } = req.body || {}
    if (!username || !email) return res.status(400).json({ error: 'username and email are required' })
    const allowed = ['buyer','farmer']
    const safeRole = allowed.includes(role) ? role : 'buyer'
    let emailVerified = false
    try {
      const clerkUser = await clerkClient.users.getUser(req.auth.userId)
      const primaryEmailObj = clerkUser?.emailAddresses?.find(e => e.id === clerkUser?.primaryEmailAddressId) || clerkUser?.emailAddresses?.[0]
      emailVerified = (primaryEmailObj?.verification?.status === 'verified') || false
    } catch { emailVerified = false }
    const inserted = await db.insert(usersTable).values({
      clerkUserId: req.auth.userId,
      username,
      email,
      role: safeRole,
      fullName: full_name,
      phone,
      location,
      emailVerified,
    }).returning()
    try {
      const clerkUser = await clerkClient.users.getUser(req.auth.userId)
      const current = (clerkUser && clerkUser.unsafeMetadata) || {}
      if (current.role !== safeRole) {
        await clerkClient.users.updateUser(req.auth.userId, { unsafeMetadata: { ...current, role: safeRole } })
      }
    } catch (e) { console.warn('Failed to set Clerk metadata role on user creation:', e) }
    res.json(inserted[0])
  } catch (error) {
    console.error('Error creating user:', error)
    res.status(500).json({ error: 'Failed to create user' })
  }
})

// Get profile
router.get('/users/profile', ensureAuth(), async (req, res) => {
  const DEBUG = process.env.PROFILE_DEBUG === 'true'
  try {
    const clerkId = req.auth.userId
    if (DEBUG) console.log(`[profile] GET /api/users/profile for ${clerkId}`)
    let rows = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, clerkId))
    if (rows.length === 0) {
      // Auto-provision from Clerk if missing (fallback if webhook missed)
      try {
        const clerkUser = await clerkClient.users.getUser(clerkId)
        if (clerkUser) {
          await handleUserCreated(clerkUser)
          rows = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, clerkId))
        }
      } catch (provisionErr) {
        console.warn('[profile] auto-provision failed:', provisionErr?.message || provisionErr)
      }
    }
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' })
    return res.json(rows[0])
  } catch (e) {
    console.error('Error fetching user profile:', e)
    return res.status(500).json({ error: 'Failed to fetch user' })
  }
})



// Update profile (large body)
router.patch('/users/profile', ensureAuth(), requireNotSuspended(), express.json({ limit: '25mb', type: 'application/json' }), async (req,res) => {
  try {
    const me = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    if (me.length === 0) return res.status(404).json({ error: 'User not found' })
  const { username, email, full_name, phone, location, profile_image_url, profile_image_blurhash, banner_image_url, banner_image_blurhash } = req.body || {}
    if (typeof username === 'string' && username.trim()) {
      const taken = await db.select().from(usersTable).where(eq(usersTable.username, username.trim()))
      if (taken.length > 0 && taken[0].id !== me[0].id) return res.status(409).json({ error: 'conflict', field: 'username', message: 'Username already taken' })
    }
    if (typeof email === 'string' && email.trim()) {
      const emailNorm = email.trim()
      const taken = await db.select().from(usersTable).where(eq(usersTable.email, emailNorm))
      if (taken.length > 0 && taken[0].id !== me[0].id) return res.status(409).json({ error: 'conflict', field: 'email', message: 'Email already in use' })
    }
    const updates = {}
    if (typeof username !== 'undefined') updates.username = username?.trim() || null
    if (typeof email !== 'undefined') updates.email = email?.trim() || null
    if (typeof full_name !== 'undefined') updates.fullName = full_name || null
    if (typeof phone !== 'undefined') updates.phone = phone || null
    if (typeof location !== 'undefined') updates.location = location || null
    if (typeof profile_image_url !== 'undefined') {
      const { AWS_S3_BUCKET, AWS_S3_REGION, AWS_CLOUDFRONT_DOMAIN } = ENV
      const allowlistHosts = []
      if (AWS_S3_BUCKET && AWS_S3_REGION) allowlistHosts.push(`${AWS_S3_BUCKET}.s3.${AWS_S3_REGION}.amazonaws.com`)
      if (AWS_CLOUDFRONT_DOMAIN) allowlistHosts.push(AWS_CLOUDFRONT_DOMAIN)
      const val = profile_image_url || null
      if (val === null) updates.profileImageUrl = null
      else if (allowlistHosts.length === 0) updates.profileImageUrl = val
      else {
        try {
          const u = new URL(val)
          if (!allowlistHosts.includes(u.host)) return res.status(400).json({ error: 'Invalid image URL host' })
          // Strip any query/fragments (avoid storing presigned GET URLs)
          updates.profileImageUrl = `${u.protocol}//${u.host}${u.pathname}`
        } catch { return res.status(400).json({ error: 'Invalid image URL' }) }
      }
    }
    if (typeof profile_image_blurhash !== 'undefined') updates.profileImageBlurhash = profile_image_blurhash || null
    // Banner fields (optional)
    if (typeof banner_image_url !== 'undefined') {
      const { AWS_S3_BUCKET, AWS_S3_REGION, AWS_CLOUDFRONT_DOMAIN } = ENV
      const allowlistHosts = []
      if (AWS_S3_BUCKET && AWS_S3_REGION) allowlistHosts.push(`${AWS_S3_BUCKET}.s3.${AWS_S3_REGION}.amazonaws.com`)
      if (AWS_CLOUDFRONT_DOMAIN) allowlistHosts.push(AWS_CLOUDFRONT_DOMAIN)
      const val = banner_image_url || null
      if (val === null) updates.bannerImageUrl = null
      else if (allowlistHosts.length === 0) updates.bannerImageUrl = val
      else {
        try {
          const u = new URL(val)
          if (!allowlistHosts.includes(u.host)) return res.status(400).json({ error: 'Invalid banner URL host' })
          // Strip any query/fragments (avoid storing presigned GET URLs)
          updates.bannerImageUrl = `${u.protocol}//${u.host}${u.pathname}`
        } catch { return res.status(400).json({ error: 'Invalid banner URL' }) }
      }
    }
    if (typeof banner_image_blurhash !== 'undefined') updates.bannerImageBlurhash = banner_image_blurhash || null
    updates.updatedAt = new Date()
    const updated = await db.update(usersTable).set(updates).where(eq(usersTable.clerkUserId, req.auth.userId)).returning()
    return res.json(updated[0])
  } catch (error) {
    console.error('Error updating user profile:', error)
    res.status(500).json({ error: 'Failed to update profile' })
  }
})

// Public-ish fetch user by numeric ID (no auth required for basic public profile fields)
router.get('/users/:id', async (req, res) => {
  try {
    const idNum = Number(req.params.id)
    if (isNaN(idNum)) return res.status(400).json({ error: 'Invalid user id' })
    const rows = await db.select().from(usersTable).where(eq(usersTable.id, idNum))
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' })
    const u = rows[0]
    // Limit fields to a safe public subset
    return res.json({
      id: u.id,
      username: u.username,
      full_name: u.fullName,
      role: u.role,
      is_trusted: !!u.isTrusted,
      rating_avg: Number(u.ratingAvg || 0),
      rating_count: u.ratingCount || 0,
      profile_image_url: u.profileImageUrl,
      profile_image_blurhash: u.profileImageBlurhash,
      banner_image_url: u.bannerImageUrl,
      location: u.location,
      created_at: u.createdAt,
    })
  } catch (e) {
    console.error('Error fetching user by id:', e)
    return res.status(500).json({ error: 'Failed to fetch user' })
  }
})

export default router

// Admin-only user status endpoints
router.post('/admin/users/:id/suspend', ensureAuth(), requireRole(['admin']), async (req, res) => {
  try {
    const idNum = Number(req.params.id)
    if (isNaN(idNum)) return res.status(400).json({ error: 'invalid id' })
    const rows = await db.select().from(usersTable).where(eq(usersTable.id, idNum))
    if (rows.length === 0) return res.status(404).json({ error: 'not found' })
    // Determine acting admin db id for history entries
    let adminId = null
    try {
      const meArr = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
      adminId = meArr?.[0]?.id || null
    } catch {}
    const updated = await db.update(usersTable).set({ status: 'suspended', updatedAt: new Date() }).where(eq(usersTable.id, idNum)).returning()

    // Pause ongoing orders for this user (as buyer or farmer)
    try {
      const activeStatuses = ['pending','accepted','shipped']
      const affected = await db.update(ordersTable)
        .set({ status: 'paused', updatedAt: new Date() })
        .where(and(inArray(ordersTable.status, activeStatuses), or(eq(ordersTable.buyerId, idNum), eq(ordersTable.farmerId, idNum))))
        .returning()
      if (affected?.length && adminId) {
        for (const ord of affected) {
          await db.insert(orderStatusHistoryTable).values({
            orderId: ord.id,
            fromStatus: null, // unknown previous here; full history still tracks earlier state
            toStatus: 'paused',
            changedByUserId: adminId,
          })
        }
      }
    } catch (e) { console.warn('pause orders on suspend failed', e?.message || e) }

    // Notify user about suspension
    try {
      await createNotification(db, {
        userId: idNum,
        type: 'account_suspended',
        title: 'Account suspended',
        body: 'Your account has been suspended. You cannot place orders, mark deliveries, post reviews or comments, or create/edit listings until reactivated.',
        data: { route: '/appeals' }
      })
    } catch {}

    return res.json({ ok: true, user: updated[0] })
  } catch (e) {
    console.error('suspend error', e)
    return res.status(500).json({ error: 'failed' })
  }
})

router.post('/admin/users/:id/unsuspend', ensureAuth(), requireRole(['admin']), async (req, res) => {
  try {
    const idNum = Number(req.params.id)
    if (isNaN(idNum)) return res.status(400).json({ error: 'invalid id' })
    const rows = await db.select().from(usersTable).where(eq(usersTable.id, idNum))
    if (rows.length === 0) return res.status(404).json({ error: 'not found' })
    // Determine acting admin db id for history entries
    let adminId = null
    try {
      const meArr = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
      adminId = meArr?.[0]?.id || null
    } catch {}
    const updated = await db.update(usersTable).set({ status: 'active', updatedAt: new Date() }).where(eq(usersTable.id, idNum)).returning()

    // Resume paused orders for this user by restoring last non-paused status
    try {
      // Fetch all paused orders
      const pausedOrders = await db.select().from(ordersTable).where(and(eq(ordersTable.status, 'paused'), or(eq(ordersTable.buyerId, idNum), eq(ordersTable.farmerId, idNum))))
      for (const ord of pausedOrders) {
        // Find the last history entry whose toStatus != 'paused'
        let prevStatus = 'pending'
        try {
          const allHist = await db.select().from(orderStatusHistoryTable).where(eq(orderStatusHistoryTable.orderId, ord.id))
          // order newest first and find first non-paused
          allHist.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))
          const prior = allHist.find(h => String(h.toStatus).toLowerCase() !== 'paused')
          if (prior && prior.toStatus) prevStatus = prior.toStatus
        } catch {}
        const updatedOrder = await db.update(ordersTable).set({ status: prevStatus, updatedAt: new Date() }).where(eq(ordersTable.id, ord.id)).returning()
        if (adminId && updatedOrder?.[0]) {
          await db.insert(orderStatusHistoryTable).values({
            orderId: ord.id,
            fromStatus: 'paused',
            toStatus: prevStatus,
            changedByUserId: adminId,
          })
        }
      }
    } catch (e) { console.warn('resume orders on unsuspend failed', e?.message || e) }

    // Notify about reactivation
    try {
      await createNotification(db, {
        userId: idNum,
        type: 'account_reactivated',
        title: 'Account reactivated',
        body: 'Your account has been reactivated. You can now resume normal activity.'
      })
    } catch {}

    return res.json({ ok: true, user: updated[0] })
  } catch (e) {
    console.error('unsuspend error', e)
    return res.status(500).json({ error: 'failed' })
  }
})

router.post('/admin/users/:id/ban', ensureAuth(), requireRole(['admin']), async (req, res) => {
  try {
    const idNum = Number(req.params.id)
    if (isNaN(idNum)) return res.status(400).json({ error: 'invalid id' })
    const rows = await db.select().from(usersTable).where(eq(usersTable.id, idNum))
    if (rows.length === 0) return res.status(404).json({ error: 'not found' })
    const updated = await db.update(usersTable).set({ status: 'inactive', updatedAt: new Date() }).where(eq(usersTable.id, idNum)).returning()
    return res.json({ ok: true, user: updated[0] })
  } catch (e) {
    console.error('ban error', e)
    return res.status(500).json({ error: 'failed' })
  }
})

// Admin: toggle trusted badge (manual only)
router.post('/admin/users/:id/trust', ensureAuth(), requireRole(['admin']), async (req, res) => {
  try {
    const idNum = Number(req.params.id)
    const { trusted } = req.body || {}
    if (isNaN(idNum)) return res.status(400).json({ error: 'invalid id' })
    if (typeof trusted !== 'boolean') return res.status(400).json({ error: 'trusted must be boolean' })
    const exists = await db.select().from(usersTable).where(eq(usersTable.id, idNum))
    if (!exists.length) return res.status(404).json({ error: 'not found' })
    const updated = await db.update(usersTable).set({ isTrusted: trusted, updatedAt: new Date() }).where(eq(usersTable.id, idNum)).returning()
    return res.json({ ok: true, user: updated[0] })
  } catch (e) {
    console.error('trust toggle error', e)
    return res.status(500).json({ error: 'failed' })
  }
})