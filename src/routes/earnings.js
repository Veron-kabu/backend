import { Router } from 'express'
import { db } from '../config/db.js'
import { ordersTable, productsTable, usersTable } from '../db/schema.js'
import { ensureAuth } from '../middleware/auth.js'
import { eq, inArray } from 'drizzle-orm'

// Earnings & per-listing performance for farmers
// NOTE: Profit requires cost basis. We expose placeholders (null) for now; client can hide or future patch can backfill costs table.
const router = Router()

router.get('/earnings/farmer/summary', ensureAuth(), async (req,res) => {
  try {
    // Resolve farmer DB id
    let dbUserId = req.auth?.dbUserId
    if (!dbUserId) {
      const rows = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
      dbUserId = rows[0]?.id
      if (dbUserId) req.auth.dbUserId = dbUserId
    }
    if (!dbUserId) return res.status(401).json({ error: 'Unauthorized' })
    const meRows = await db.select().from(usersTable).where(eq(usersTable.id, dbUserId))
    if (meRows.length === 0 || meRows[0].role !== 'farmer') return res.status(403).json({ error: 'Not a farmer' })

    // Fetch products owned
  const prods = await db.select().from(productsTable).where(eq(productsTable.farmerId, dbUserId))
    const productIds = prods.map(p => p.id)
    let orders = []
    if (productIds.length > 0) {
      orders = await db.select().from(ordersTable).where(inArray(ordersTable.productId, productIds))
    }
    const deliveredStatuses = new Set(['delivered','completed'])
    const now = new Date()
    const dayMs = 24*60*60*1000
    // Prepare 7-day buckets (including today) keyed by yyyy-mm-dd
    const dailyBuckets = {}
    for (let i=6;i>=0;i--) {
      const d = new Date(now.getTime() - i*dayMs)
      const key = d.toISOString().slice(0,10)
      dailyBuckets[key] = 0
    }
  let totalRevenue = 0
  let totalDelivered = 0
  let activeOrders = 0
    const perListing = new Map()
    for (const o of orders) {
      const amt = Number(o.totalAmount) || 0
      const entry = perListing.get(o.productId) || { productId: o.productId, orders: 0, delivered: 0, revenue: 0, qty: 0, deliveredQty: 0, unitPriceSum: 0, lastOrderAt: null }
      entry.orders += 1
      entry.qty += Number(o.quantity) || 0
      entry.unitPriceSum += Number(o.unitPrice) || 0
      if (deliveredStatuses.has((o.status||'').toLowerCase())) {
        entry.delivered += 1
        entry.revenue += amt
        entry.deliveredQty += Number(o.quantity) || 0
        totalRevenue += amt
        totalDelivered += 1
      } else {
        // Count only actionable orders as 'active' (exclude cancelled/rejected)
        const lower = (o.status||'').toLowerCase()
        if (['pending','accepted','shipped'].includes(lower)) activeOrders += 1
      }
      const created = o.createdAt instanceof Date ? o.createdAt : new Date(o.createdAt)
      if (!isNaN(created)) {
        if (!entry.lastOrderAt || created > entry.lastOrderAt) entry.lastOrderAt = created
        const key = created.toISOString().slice(0,10)
        if (dailyBuckets[key] != null && deliveredStatuses.has((o.status||'').toLowerCase())) {
          dailyBuckets[key] += amt
        }
      }
      perListing.set(o.productId, entry)
    }
    const listingStats = prods.map(p => {
      const s = perListing.get(p.id) || { productId: p.id, orders: 0, delivered: 0, revenue: 0, qty: 0, deliveredQty: 0, unitPriceSum: 0, lastOrderAt: null }
      const avgUnitPrice = s.unitPriceSum && s.orders ? (s.unitPriceSum / s.orders) : 0
      return {
        id: p.id,
        title: p.title,
        price: Number(p.price),
        unit: p.unit,
        status: p.status,
        orders: s.orders,
        delivered: s.delivered,
        revenue: s.revenue,
        totalQuantity: s.qty,
        deliveredQuantity: s.deliveredQty,
        avgUnitPrice,
        lastOrderAt: s.lastOrderAt ? s.lastOrderAt.toISOString() : null,
        profit: null, // Placeholder until cost basis is implemented
        profitMargin: null,
      }
    })
    const activeListings = listingStats.filter(l => l.status === 'active').length
    const trend = Object.entries(dailyBuckets).map(([date, revenue]) => ({ date, revenue }))
    res.json({
      currency: 'KES',
      totalRevenue,
      activeOrders,
      deliveredOrders: totalDelivered,
      listings: listingStats,
      activeListings,
      trend,
      profit: null,
      profitMargin: null,
      loss: null,
    })
  } catch (e) {
    console.error('earnings summary error', e)
    res.status(500).json({ error: 'Failed to load earnings summary' })
  }
})

export default router