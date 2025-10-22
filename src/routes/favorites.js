import { Router } from 'express'
import { db } from '../config/db.js'
import { favoritesTable, productsTable, usersTable } from '../db/schema.js'
import { ensureAuth, clerkClient } from '../middleware/auth.js'
import { and, eq, inArray } from 'drizzle-orm'

const router = Router()

// Resolve (and cache) DB user id from Clerk auth
async function resolveDbUserId(req) {
  if (req.auth?.dbUserId) return req.auth.dbUserId
  if (!req.auth?.userId) return null
  const rows = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
  let id = rows[0]?.id || null
  if (!id) {
    // Auto-provision DB user row if missing to avoid 401 for first-time favorite usage
    try {
      const user = await clerkClient.users.getUser(req.auth.userId)
      const email = user?.primaryEmailAddress?.emailAddress || user?.emailAddresses?.[0]?.emailAddress || `unknown+${req.auth.userId}@example.com`
      const baseUsername = user?.username || (email ? email.split('@')[0] : 'user')
      const roleMeta = (user?.publicMetadata?.role || user?.privateMetadata?.role || '').toString()
      const role = ['buyer','farmer','admin'].includes(roleMeta) ? roleMeta : 'buyer'
      // Ensure unique-ish username (append short suffix if needed)
      let username = baseUsername.toLowerCase()
      if (rows.some(r => r.username === username)) {
        username = `${username}_${Date.now().toString(36).slice(-4)}`
      }
      const inserted = await db.insert(usersTable).values({
        clerkUserId: req.auth.userId,
        username,
        email,
        role,
        fullName: user?.fullName || user?.firstName || null,
        status: 'active'
      }).returning()
      id = inserted[0]?.id || null
    } catch (e) {
      console.error('Auto-provision user failed:', e)
    }
  }
  if (id) req.auth.dbUserId = id
  return id
}

// Toggle favorite for a product – allowed for buyers & farmers (cannot favorite own product)
router.post('/favorites/:productId/toggle', ensureAuth(), async (req,res) => {
  try {
    const userId = await resolveDbUserId(req)
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })
    const productId = Number(req.params.productId)
    if (isNaN(productId)) return res.status(400).json({ error: 'Invalid product id' })
    const prodRows = await db.select().from(productsTable).where(eq(productsTable.id, productId))
    if (prodRows.length === 0) return res.status(404).json({ error: 'Product not found' })
  if (prodRows[0].farmerId === userId) return res.status(400).json({ error: 'Cannot favorite your own product' })
    const existing = await db.select().from(favoritesTable).where(and(eq(favoritesTable.buyerId, userId), eq(favoritesTable.productId, productId)))
    if (existing.length > 0) {
      await db.delete(favoritesTable).where(eq(favoritesTable.id, existing[0].id))
      return res.json({ favorited: false })
    }
    const inserted = await db.insert(favoritesTable).values({ buyerId: userId, productId }).returning()
    res.json({ favorited: true, id: inserted[0].id })
  } catch (e) {
    console.error('favorite toggle error', e)
    res.status(500).json({ error: 'Failed to toggle favorite' })
  }
})

// Check if favorited
router.get('/favorites/:productId/status', ensureAuth(), async (req,res) => {
  try {
    const userId = await resolveDbUserId(req)
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })
    const productId = Number(req.params.productId)
    if (isNaN(productId)) return res.status(400).json({ error: 'Invalid product id' })
    const existing = await db.select().from(favoritesTable).where(and(eq(favoritesTable.buyerId, userId), eq(favoritesTable.productId, productId)))
    res.json({ favorited: existing.length > 0 })
  } catch (e) {
    console.error('favorite status error', e)
    res.status(500).json({ error: 'Failed to fetch favorite status' })
  }
})

// List favorites for current user
router.get('/favorites', ensureAuth(), async (req,res) => {
  try {
    const userId = await resolveDbUserId(req)
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })
    const favs = await db.select().from(favoritesTable).where(eq(favoritesTable.buyerId, userId))
    if (favs.length === 0) return res.json([])
    const productIds = Array.from(new Set(favs.map(f => f.productId)))
    const products = await db.select().from(productsTable).where(inArray(productsTable.id, productIds))
    const farmerIds = Array.from(new Set(products.map(p => p.farmerId)))
    const farmers = await db.select().from(usersTable).where(inArray(usersTable.id, farmerIds))
    const productMap = new Map(products.map(p => [p.id, p]))
    const farmerMap = new Map(farmers.map(f => [f.id, f]))
    const result = favs.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)).map(f => {
      const p = productMap.get(f.productId)
      const farmer = p ? farmerMap.get(p.farmerId) : null
      if (!p) {
        return {
          id: f.id,
          createdAt: f.createdAt,
            productDeleted: true,
          product: { id: f.productId, deleted: true },
          farmer: null
        }
      }
      return {
        id: f.id,
        createdAt: f.createdAt,
        product: {
          id: p.id,
          title: p.title,
          price: p.price,
          unit: p.unit,
          images: p.images,
          location: p.location,
          farmerId: p.farmerId,
          quantityAvailable: p.quantityAvailable,
          status: p.status,
          discountPercent: p.discountPercent,
          isOrganic: p.isOrganic
        },
        farmer: farmer ? { id: farmer.id, fullName: farmer.fullName || farmer.username } : null
      }
    })
    res.json(result)
  } catch (e) {
    console.error('favorites list error', e)
    res.status(500).json({ error: 'Failed to fetch favorites' })
  }
})

export default router
