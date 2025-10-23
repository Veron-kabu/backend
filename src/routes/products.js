import { Router } from 'express'
import { db } from '../config/db.js'
import { productsTable, usersTable, ordersTable, favoritesTable } from '../db/schema.js'
import { ensureAuth } from '../middleware/auth.js'
import { requireRole } from '../middleware/role.js'
import { requireNotSuspended } from '../middleware/status.js'
import { and, eq, gt, gte, lte, lt, inArray, ilike, desc } from 'drizzle-orm'
import { computeBlurhashFromUrl } from '../utils/blurhash.js'
import { takeToken } from '../utils/rateLimit.js'
import { userVerificationTable } from '../db/schema.js'

const router = Router()

// Allowed product categories (ids) - keep in sync with mobile/constants/categories.js (excluding 'all')
const ALLOWED_CATEGORIES = new Set([
  'vegetables','fruits','grains','roots','nuts','dairy','eggs'
])

router.get('/products', async (req,res) => {
  try {
    const { category, min_price, max_price, is_organic, limit, cursor, search } = req.query
    // Default to paginated response with a sane default size
    const pageSize = Math.min(Number(limit) || 24, 100)
    let whereExpr = and(eq(productsTable.status, 'active'), gt(productsTable.quantityAvailable, 0))
    if (category) whereExpr = and(whereExpr, eq(productsTable.category, category))
    if (min_price) whereExpr = and(whereExpr, gte(productsTable.price, min_price))
    if (max_price) whereExpr = and(whereExpr, lte(productsTable.price, max_price))
    if (is_organic === 'true') whereExpr = and(whereExpr, eq(productsTable.isOrganic, true))
    if (search && String(search).trim().length > 0) {
      const q = `%${String(search).trim()}%`
      whereExpr = and(whereExpr, ilike(productsTable.title, q))
    }
    if (cursor) {
      // cursor is ISO date string of createdAt
      const d = new Date(cursor)
      if (!isNaN(d.getTime())) whereExpr = and(whereExpr, lt(productsTable.createdAt, d))
    }
    
    // Join with users table to get farmer information
    let query = db.select({
      ...productsTable,
      farmerEmail: usersTable.email,
      farmerName: usersTable.fullName,
      farmerUsername: usersTable.username,
      farmerRatingAvg: usersTable.ratingAvg,
      farmerRatingCount: usersTable.ratingCount,
    })
    .from(productsTable)
    .leftJoin(usersTable, eq(productsTable.farmerId, usersTable.id))
    .where(whereExpr)
    .orderBy(desc(productsTable.createdAt))
    .limit(pageSize + 1)
    
    let rows = await query
    const sliced = rows.slice(0, pageSize)
    const nextCursor = rows.length > pageSize ? rows[pageSize - 1].createdAt : null
    return res.json({ items: sliced, nextCursor })
  } catch (e) {
    console.error('Error fetching products:', e)
    res.status(500).json({ error: 'Failed to fetch products' })
  }
})

router.get('/products/:id', async (req,res) => {
  try {
    const productId = Number(req.params.id)
    if (isNaN(productId)) return res.status(400).json({ error: 'Invalid product ID' })
    
    const product = await db.select({
      ...productsTable,
      farmerEmail: usersTable.email,
      farmerName: usersTable.fullName,
      farmerUsername: usersTable.username,
      farmerRatingAvg: usersTable.ratingAvg,
      farmerRatingCount: usersTable.ratingCount,
    })
    .from(productsTable)
    .leftJoin(usersTable, eq(productsTable.farmerId, usersTable.id))
    .where(eq(productsTable.id, productId))
    
    if (product.length === 0) return res.status(404).json({ error: 'Product not found' })
    res.json(product[0])
  } catch (e) {
    console.error('Error fetching product details:', e)
    res.status(500).json({ error: 'Failed to fetch product details' })
  }
})

// Bulk fetch products by ids: /api/products/bulk?ids=1,2,3
router.get('/products/bulk', async (req,res) => {
  try {
    const idsParam = req.query.ids
    if (!idsParam) return res.status(400).json({ error: 'ids query required (comma separated)' })
    const ids = String(idsParam)
      .split(',')
      .map(s => Number(s.trim()))
      .filter(n => Number.isInteger(n) && n > 0)
      .slice(0, 100)
    if (ids.length === 0) return res.json([])
    let rows = await db.select().from(productsTable).where(inArray(productsTable.id, ids))
    // Preserve order of requested ids
    const orderMap = new Map(rows.map(r => [r.id, r]))
    const ordered = ids.map(id => orderMap.get(id)).filter(Boolean)
    res.json(ordered)
  } catch (e) {
    console.error('Bulk product fetch failed', e)
    res.status(500).json({ error: 'Failed bulk fetch' })
  }
})

// NOTE: Price is stored in decimal in KES (Kenyan Shillings). Client must treat value as Ksh, not USD.
router.post('/products', ensureAuth(), requireNotSuspended(), requireRole(['farmer']), async (req,res) => {
  try {
    const key = `product_create_${req.auth.userId}`
    if (!takeToken(key, { capacity: 10, refillRatePerSec: 0.25 })) return res.status(429).json({ error: 'Too many product creations, slow down' })
    // Enforce verified-only product creation for farmers
    // Enforce verified-only product creation for farmers based on DB status
    const vrow = await db.select().from(userVerificationTable).where(eq(userVerificationTable.userId, db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))))
    const vstatus = vrow?.[0]?.status || 'unverified'
    if (vstatus !== 'verified') {
      return res.status(403).json({ error: 'Verification required to post listings', status: vstatus })
    }
    const user = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
  let { title, category, price, unit, quantity_available, location, discount_percent } = req.body
    if (!title || !category || !price || !unit || !quantity_available || !location) return res.status(400).json({ error: 'Missing required product fields' })
    // Normalize and validate category
    category = String(category || '').toLowerCase()
    if (!ALLOWED_CATEGORIES.has(category)) {
      return res.status(400).json({ error: 'Invalid category', allowed: Array.from(ALLOWED_CATEGORIES) })
    }
  const { description, minimum_order, harvest_date, expiry_date, images, is_organic } = req.body
    // Enforce single image: keep only the first URL if provided
    const safeImages = Array.isArray(images) && images.length > 0
      ? [String(images[0])]
      : []
    const inserted = await db.insert(productsTable).values({
      farmerId: user[0].id,
      title,
      description,
  category,
  // Price accepted as Ksh (string/number). Validation happens below; Drizzle decimal will store exactly.
  price,
      unit,
      quantityAvailable: quantity_available,
      minimumOrder: minimum_order,
      harvestDate: harvest_date,
      expiryDate: expiry_date,
      location,
  images: safeImages,
      isOrganic: is_organic,
  discountPercent: typeof discount_percent === 'number' ? Math.min(Math.max(discount_percent, 0), 90) : 0,
      imageBlurhashes: [],
    }).returning()
    ;(async () => {
      try {
        if (Array.isArray(safeImages) && safeImages.length > 0) {
          const slice = safeImages.slice(0,1)
          const concurrency = 3
          const queue = [...slice]
          const hashes = []
          async function worker() {
            while (queue.length) {
              const url = queue.shift()
              try { const { hash } = await computeBlurhashFromUrl(url); hashes.push(hash) } catch {}
            }
          }
          await Promise.all(Array.from({ length: Math.min(concurrency, slice.length) }, () => worker()))
          if (hashes.length > 0) await db.update(productsTable).set({ imageBlurhashes: hashes, updatedAt: new Date() }).where(eq(productsTable.id, inserted[0].id))
        }
      } catch (e) { console.warn('product blurhash generation failed', e) }
    })()
    res.json(inserted[0])
  } catch (e) {
    console.error('Error creating product:', e)
    res.status(500).json({ error: 'Failed to create product' })
  }
})

// Update product (farmer-owned) – allow updating discount, price, quantity, status (limited)
// Extend PATCH to optionally add/remove images (array). Pass either images_add (array of URLs) or
// images_remove (array of exact URLs to remove). Both may be supplied. New images will trigger blurhash job later.
router.patch('/products/:id', ensureAuth(), requireNotSuspended({ allowAdminBypass: true }), requireRole(['farmer','admin']), async (req,res) => {
  try {
    const productId = Number(req.params.id)
    if (isNaN(productId)) return res.status(400).json({ error: 'Invalid product ID' })
    const existing = await db.select().from(productsTable).where(eq(productsTable.id, productId))
    if (existing.length === 0) return res.status(404).json({ error: 'Product not found' })
    const prod = existing[0]
    // Resolve DB user id for authenticated Clerk user (needed for ownership checks)
    let dbUserId = req.auth?.dbUserId
    if (!dbUserId) {
      const userRows = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
      dbUserId = userRows[0]?.id
      if (dbUserId) req.auth.dbUserId = dbUserId // cache for downstream routes
    }
    // If not admin ensure farmer owns product
    if (req.userRole !== 'admin' && prod.farmerId !== dbUserId) {
      return res.status(403).json({ error: 'Forbidden (not owner)' })
    }
  const { discount_percent, price, quantity_available, status, images_add, images_remove, description } = req.body || {}
    const updates = { updatedAt: new Date() }
    if (typeof discount_percent !== 'undefined') {
      const d = Number(discount_percent)
      if (!Number.isFinite(d) || d < 0 || d > 90) return res.status(400).json({ error: 'Invalid discount_percent (0-90)' })
      updates.discountPercent = Math.round(d)
    }
    if (typeof price !== 'undefined') {
      const pNum = Number(price)
      if (!Number.isFinite(pNum) || pNum <= 0) return res.status(400).json({ error: 'Invalid price (must be positive Ksh number)' })
      updates.price = pNum
    }
    if (typeof quantity_available !== 'undefined') {
      const q = Number(quantity_available)
      if (!Number.isInteger(q) || q < 0) return res.status(400).json({ error: 'Invalid quantity_available' })
      updates.quantityAvailable = q
    }
    if (typeof status !== 'undefined') {
      const allowedStatuses = ['active','inactive','sold','expired']
      if (!allowedStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' })
      // Non-admin path already ensured ownership. Extra safeguard: only owner (farmer) or admin may set status.
      updates.status = status
    }
    // Description (optional) – allow clearing by sending empty string or null
    if (Object.prototype.hasOwnProperty.call(req.body, 'description')) {
      if (description === null || (typeof description === 'string')) {
        if (typeof description === 'string') {
          const trimmed = description.trim()
          if (trimmed.length > 1000) return res.status(400).json({ error: 'Description too long (max 1000 chars)' })
          updates.description = trimmed.length === 0 ? null : trimmed
        } else {
          updates.description = null
        }
      } else {
        return res.status(400).json({ error: 'Invalid description' })
      }
    }
    // Images mutation logic
    let nextImages = null
    if (Array.isArray(images_add) || Array.isArray(images_remove)) {
      const current = Array.isArray(prod.images) ? [...prod.images] : []
      if (Array.isArray(images_remove)) {
        for (const r of images_remove) {
          const idx = current.indexOf(r)
            ;(idx >= 0) && current.splice(idx,1)
        }
      }
      if (Array.isArray(images_add)) {
        // Prepend new images so the first one becomes the primary image
        for (const a of images_add) {
          if (typeof a === 'string' && a.startsWith('http')) current.unshift(a)
        }
        // De-duplicate while preserving first occurrence (prefer the new image at the front)
        const seen = new Set()
        for (let i = 0; i < current.length; i++) {
          const url = current[i]
          if (seen.has(url)) { current.splice(i,1); i--; } else { seen.add(url) }
        }
      }
      // Enforce single image only
      nextImages = current.slice(0,1)
      updates.images = nextImages
      // Reset blurhashes so backfill job can regenerate if images changed
      updates.imageBlurhashes = []
    }
    if (Object.keys(updates).length === 1) return res.status(400).json({ error: 'No valid fields to update' })
    const updated = await db.update(productsTable).set(updates).where(eq(productsTable.id, productId)).returning()
    return res.json(updated[0])
  } catch (e) {
    console.error('Error updating product:', e)
    return res.status(500).json({ error: 'Failed to update product' })
  }
})

// Hard delete: permanently remove product if no orders reference it. If orders exist, block deletion.
router.delete('/products/:id', ensureAuth(), requireNotSuspended({ allowAdminBypass: true }), requireRole(['farmer','admin']), async (req,res) => {
  try {
    const productId = Number(req.params.id)
    if (isNaN(productId)) return res.status(400).json({ error: 'Invalid product ID' })
    const existing = await db.select().from(productsTable).where(eq(productsTable.id, productId))
    if (existing.length === 0) return res.status(404).json({ error: 'Not found' })
    const prod = existing[0]
    let dbUserId = req.auth?.dbUserId
    if (!dbUserId) {
      const userRows = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
      dbUserId = userRows[0]?.id
      if (dbUserId) req.auth.dbUserId = dbUserId
    }
    if (req.userRole !== 'admin' && prod.farmerId !== dbUserId) return res.status(403).json({ error: 'Forbidden (not owner)' })
    // Check for referencing orders to avoid FK constraint violations
    const [{ count: orderCount }] = await db.execute(sql`SELECT COUNT(*)::int as count FROM orders WHERE product_id = ${productId}`)
    if (orderCount > 0) {
      return res.status(409).json({ error: 'Product has existing orders and cannot be deleted permanently. Mark it inactive instead.' })
    }
  // Cascade cleanup: remove favorites tied to this product (no orders exist here by earlier check)
  const removedFavorites = await db.delete(favoritesTable).where(eq(favoritesTable.productId, productId)).returning()
  const deleted = await db.delete(productsTable).where(eq(productsTable.id, productId)).returning()
  return res.json({ ok: true, deleted: true, removedFavorites: removedFavorites.length, product: deleted[0] })
  } catch (e) {
    console.error('hard delete error', e)
    res.status(500).json({ error: 'Failed to delete product' })
  }
})

// Restore product (inactive -> active)
router.post('/products/:id/restore', ensureAuth(), requireNotSuspended({ allowAdminBypass: true }), requireRole(['farmer','admin']), async (req,res) => {
  try {
    const productId = Number(req.params.id)
    if (isNaN(productId)) return res.status(400).json({ error: 'Invalid product ID' })
    const existing = await db.select().from(productsTable).where(eq(productsTable.id, productId))
    if (existing.length === 0) return res.status(404).json({ error: 'Not found' })
    const prod = existing[0]
    let dbUserId = req.auth?.dbUserId
    if (!dbUserId) {
      const userRows = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
      dbUserId = userRows[0]?.id
      if (dbUserId) req.auth.dbUserId = dbUserId
    }
    if (req.userRole !== 'admin' && prod.farmerId !== dbUserId) return res.status(403).json({ error: 'Forbidden (not owner)' })
    if (prod.status !== 'inactive') return res.status(400).json({ error: 'Product not inactive' })
    const updated = await db.update(productsTable).set({ status: 'active', updatedAt: new Date() }).where(eq(productsTable.id, productId)).returning()
    return res.json({ ok: true, product: updated[0] })
  } catch (e) {
    console.error('restore error', e)
    res.status(500).json({ error: 'Failed to restore product' })
  }
})

export default router

// Public: list products by seller (farmer) id
// Example: GET /api/users/:id/products?status=active
router.get('/users/:id/products', async (req,res) => {
  try {
    const sellerId = Number(req.params.id)
    const { status } = req.query || {}
    if (!Number.isFinite(sellerId)) return res.status(400).json({ error: 'Invalid user id' })
    let whereExpr = eq(productsTable.farmerId, sellerId)
    if (typeof status === 'string') {
      whereExpr = and(whereExpr, eq(productsTable.status, status))
    }
    const rows = await db.select().from(productsTable).where(whereExpr)
    // Newest first
    rows.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))
    res.json({ items: rows, total: rows.length })
  } catch (e) {
    console.error('list seller products failed', e)
    res.status(500).json({ error: 'Failed to fetch seller products' })
  }
})