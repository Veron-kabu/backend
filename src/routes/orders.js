import { Router } from 'express'
import { db } from '../config/db.js'
import { ordersTable, usersTable, productsTable, reviewsTable, orderStatusHistoryTable } from '../db/schema.js'
import { ensureAuth } from '../middleware/auth.js'
import { requireRole } from '../middleware/role.js'
import { requireNotSuspended } from '../middleware/status.js'
import { and, eq, inArray } from 'drizzle-orm'

const router = Router()

// Unified orders listing endpoint supporting buyer=me or farmer=me
router.get('/orders', ensureAuth(), async (req,res) => {
  try {
    const { buyer, farmer, limit: limitStr, offset: offsetStr } = req.query
    const isBuyerQuery = buyer === 'me'
    const isFarmerQuery = farmer === 'me'
    if (!isBuyerQuery && !isFarmerQuery) return res.status(400).json({ error: 'Specify buyer=me or farmer=me' })
    // Fetch current user
    const meArr = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    if (meArr.length === 0) return res.status(403).json({ error: 'Access denied' })
    const me = meArr[0]
  if (isBuyerQuery && !['buyer','farmer'].includes(me.role)) return res.status(403).json({ error: 'Not permitted (need buyer or farmer role)' })
    if (isFarmerQuery && me.role !== 'farmer') return res.status(403).json({ error: 'Not a farmer' })
    let limit = Number(limitStr); let offset = Number(offsetStr)
    if (!Number.isFinite(limit) || limit <= 0 || limit > 100) limit = 25
    if (!Number.isFinite(offset) || offset < 0) offset = 0
    let rows = []
    if (isBuyerQuery) rows = await db.select().from(ordersTable).where(eq(ordersTable.buyerId, me.id))
    else rows = await db.select().from(ordersTable).where(eq(ordersTable.farmerId, me.id))
    rows = rows.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))
    const pageRows = rows.slice(offset, offset + limit)
    const productIds = Array.from(new Set(pageRows.map(r => r.productId)))
    const otherUserIds = isBuyerQuery ? pageRows.map(r => r.farmerId) : pageRows.map(r => r.buyerId)
    const uniqueOtherIds = Array.from(new Set(otherUserIds))
    const orderIds = pageRows.map(r => r.id)
    const [products, counterpartUsers] = await Promise.all([
      productIds.length ? db.select().from(productsTable).where(inArray(productsTable.id, productIds)) : Promise.resolve([]),
      uniqueOtherIds.length ? db.select().from(usersTable).where(inArray(usersTable.id, uniqueOtherIds)) : Promise.resolve([]),
    ])
    let myReviews = []
    if (isBuyerQuery && orderIds.length) {
      myReviews = await db.select().from(reviewsTable).where(and(eq(reviewsTable.reviewerId, me.id), inArray(reviewsTable.orderId, orderIds)))
    }
    const productMap = new Map(products.map(p => [p.id, p]))
    const counterpartMap = new Map(counterpartUsers.map(u => [u.id, u]))
    const reviewMap = new Map(myReviews.map(r => [r.orderId, r]))
    const result = pageRows.map(o => ({
      id: o.id,
      status: o.status,
      totalAmount: o.totalAmount,
      createdAt: o.createdAt,
      hasReview: isBuyerQuery ? reviewMap.has(o.id) : undefined,
      reviewRating: isBuyerQuery ? (reviewMap.get(o.id)?.rating ?? null) : undefined,
      product: (() => {
        const p = productMap.get(o.productId)
        if (!p) return { id: o.productId, title: null, price: null, unit: null, imageUrl: null, imageBlurhash: null }
        const thumbs = Array.isArray(p.thumbnails) ? p.thumbnails : []
        const imgs = Array.isArray(p.images) ? p.images : []
        const hashes = Array.isArray(p.imageBlurhashes) ? p.imageBlurhashes : []
        const firstUrl = (thumbs[0] || imgs[0]) || null
        const firstHash = (hashes[0]) || null
        return { id: p.id, title: p.title, price: p.price, unit: p.unit, imageUrl: firstUrl, imageBlurhash: firstHash }
      })(),
      // Provide consistent counterpart object key: farmer / buyer
      ...(isBuyerQuery ? { farmer: (() => { const f = counterpartMap.get(o.farmerId); return f ? { id: f.id, fullName: f.fullName || f.username } : { id: o.farmerId, fullName: null } })() }
        : { buyer: (() => { const b = counterpartMap.get(o.buyerId); return b ? { id: b.id, fullName: b.fullName || b.username } : { id: o.buyerId, fullName: null } })() })
    }))
    res.json({ items: result, total: rows.length, limit, offset })
  } catch (e) { console.error('Error fetching orders:', e); res.status(500).json({ error: 'Failed to fetch orders' }) }
})

// Allow farmers to also act as buyers when purchasing products from other farmers
router.post('/orders', ensureAuth(), requireNotSuspended(), requireRole(['buyer','farmer']), async (req,res) => {
  try {
    const buyer = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    const { product_id, quantity, delivery_address, notes } = req.body
    if (!product_id || !quantity || !delivery_address) return res.status(400).json({ error: 'Missing required order fields' })
    const product = await db.select().from(productsTable).where(and(eq(productsTable.id, product_id), eq(productsTable.status, 'active')))
    if (product.length === 0) return res.status(404).json({ error: 'Product not found or not available' })
    // Prevent ordering own listing if farmer is ordering
    if (buyer[0].role === 'farmer' && product[0].farmerId === buyer[0].id) {
      return res.status(400).json({ error: 'Cannot order your own product' })
    }
    if (product[0].quantityAvailable < quantity) return res.status(400).json({ error: 'Insufficient quantity available' })
    const total_amount = Number(product[0].price) * quantity
    // Attempt atomic-like update (optimistic concurrency) to decrement stock and set status when depleted
    const originalQty = product[0].quantityAvailable
    const nextQty = originalQty - quantity
    const updateFields = { quantityAvailable: nextQty, updatedAt: new Date() }
    if (nextQty <= 0) {
      updateFields.status = 'sold'
    }
    const updatedProduct = await db.update(productsTable)
      .set(updateFields)
      .where(and(eq(productsTable.id, product_id), eq(productsTable.quantityAvailable, originalQty)))
      .returning()
    if (updatedProduct.length === 0) {
      // Stock changed between read & update
      return res.status(409).json({ error: 'Stock changed, please retry order' })
    }
    const inserted = await db.insert(ordersTable).values({
      buyerId: buyer[0].id,
      farmerId: product[0].farmerId,
      productId: product_id,
      quantity,
      unitPrice: product[0].price,
      totalAmount: total_amount,
      deliveryAddress: delivery_address,
      notes,
    }).returning()
    // record initial status history
    await db.insert(orderStatusHistoryTable).values({
      orderId: inserted[0].id,
      fromStatus: null,
      toStatus: inserted[0].status,
      changedByUserId: buyer[0].id,
    })
    res.json({ ...inserted[0], remainingQuantity: nextQty, productStatus: updateFields.status || product[0].status })
  } catch (e) { console.error('Error creating order:', e); res.status(500).json({ error: 'Failed to create order' }) }
})

// Patch order status (farmer/admin). Accept both /:id/status and plain /:id for flexibility.
router.patch('/orders/:id/status', ensureAuth(), requireNotSuspended({ allowAdminBypass: true }), requireRole(['farmer','admin']), async (req,res) => {
  try {
    const orderId = Number(req.params.id)
    const { status } = req.body
  const validStatuses = ['pending','accepted','rejected','shipped','delivered','cancelled','paused']
    if (isNaN(orderId)) return res.status(400).json({ error: 'Invalid order ID' })
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status value' })
    const existing = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId))
    if (existing.length === 0) return res.status(404).json({ error: 'Order not found' })
    const prevStatus = existing[0].status
    // Restrict 'delivered' to buyer flow only (farmers cannot mark delivered)
    if (req.userRole !== 'admin' && String(status).toLowerCase() === 'delivered') {
      return res.status(403).json({ error: 'Only the buyer can mark an order as delivered' })
    }
    const updated = await db.update(ordersTable).set({ status }).where(eq(ordersTable.id, orderId)).returning()
    if (updated.length === 0) return res.status(404).json({ error: 'Order not found' })
    const actor = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    if (actor.length) {
      await db.insert(orderStatusHistoryTable).values({
        orderId: orderId,
        fromStatus: prevStatus,
        toStatus: status,
        changedByUserId: actor[0].id,
      })
    }
    res.json(updated[0])
  } catch (e) { console.error('Error updating order status:', e); res.status(500).json({ error: 'Failed to update order status' }) }
})

// Buyer marks an order as delivered (single-purpose endpoint)
router.post('/orders/:id/mark-delivered', ensureAuth(), requireNotSuspended(), async (req,res) => {
  try {
    const orderId = Number(req.params.id)
    if (isNaN(orderId)) return res.status(400).json({ error: 'Invalid order ID' })
    // Resolve db user id
    let dbUserId = req.auth?.dbUserId
    if (!dbUserId) {
      const rows = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
      dbUserId = rows[0]?.id
      if (dbUserId) req.auth.dbUserId = dbUserId
    }
    if (!dbUserId) return res.status(401).json({ error: 'Unauthorized' })
    const existing = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId))
    if (existing.length === 0) return res.status(404).json({ error: 'Order not found' })
    const ord = existing[0]
    if (ord.buyerId !== dbUserId) return res.status(403).json({ error: 'Only the buyer can mark this order as delivered' })
    const current = String(ord.status || '').toLowerCase()
    if (current !== 'shipped') return res.status(400).json({ error: 'Order must be shipped before it can be marked delivered' })
    const updatedArr = await db.update(ordersTable).set({ status: 'delivered', updatedAt: new Date() }).where(eq(ordersTable.id, orderId)).returning()
    // Record history
    await db.insert(orderStatusHistoryTable).values({ orderId, fromStatus: ord.status, toStatus: 'delivered', changedByUserId: dbUserId })
    return res.json({ ok: true, order: updatedArr[0] })
  } catch (e) {
    console.error('mark-delivered error', e)
    return res.status(500).json({ error: 'Failed to mark delivered' })
  }
})

router.patch('/orders/:id', ensureAuth(), requireNotSuspended({ allowAdminBypass: true }), requireRole(['farmer','admin']), async (req,res) => {
  try {
    const orderId = Number(req.params.id)
    const { status } = req.body || {}
  const validStatuses = ['pending','accepted','rejected','shipped','delivered','cancelled','paused']
    if (isNaN(orderId)) return res.status(400).json({ error: 'Invalid order ID' })
    if (typeof status === 'undefined') return res.status(400).json({ error: 'No updatable fields supplied' })
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status value' })
    const existing = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId))
    if (existing.length === 0) return res.status(404).json({ error: 'Order not found' })
    const prevStatus = existing[0].status
    const updated = await db.update(ordersTable).set({ status }).where(eq(ordersTable.id, orderId)).returning()
    const actor = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    if (actor.length) {
      await db.insert(orderStatusHistoryTable).values({
        orderId: orderId,
        fromStatus: prevStatus,
        toStatus: status,
        changedByUserId: actor[0].id,
      })
    }
    res.json(updated[0])
  } catch (e) { console.error('Error updating order (compat route):', e); res.status(500).json({ error: 'Failed to update order' }) }
})

// Buyer-initiated cancellation: allowed only when order is still pending and the requester is the buyer
router.post('/orders/:id/cancel', ensureAuth(), requireNotSuspended(), requireRole(['buyer','farmer']), async (req, res) => {
  try {
    const orderId = Number(req.params.id)
    if (isNaN(orderId)) return res.status(400).json({ error: 'Invalid order ID' })
    // Current user
    const meArr = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    if (!meArr.length) return res.status(403).json({ error: 'Access denied' })
    const me = meArr[0]
    // Fetch order
    const existingArr = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId))
    if (!existingArr.length) return res.status(404).json({ error: 'Order not found' })
    const existing = existingArr[0]
    // Only the buyer who created it can cancel
    if (existing.buyerId !== me.id) return res.status(403).json({ error: 'Only the buyer can cancel this order' })
    const current = (existing.status || '').toLowerCase()
    if (current !== 'pending') return res.status(400).json({ error: 'Order cannot be cancelled at this stage' })

    // Update status -> cancelled
    const updatedArr = await db.update(ordersTable).set({ status: 'cancelled' }).where(eq(ordersTable.id, orderId)).returning()
    const updated = updatedArr[0]
    // Record history
    await db.insert(orderStatusHistoryTable).values({
      orderId: orderId,
      fromStatus: existing.status,
      toStatus: 'cancelled',
      changedByUserId: me.id,
    })
    return res.json(updated)
  } catch (e) {
    console.error('Error cancelling order:', e)
    return res.status(500).json({ error: 'Failed to cancel order' })
  }
})

// Order detail with history (buyer or farmer of the order or admin)
router.get('/orders/:id', ensureAuth(), async (req,res) => {
  try {
    const orderId = Number(req.params.id)
    if (isNaN(orderId)) return res.status(400).json({ error: 'Invalid order ID' })
    const meArr = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    if (!meArr.length) return res.status(403).json({ error: 'Access denied' })
    const me = meArr[0]
    const orderArr = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId))
    if (!orderArr.length) return res.status(404).json({ error: 'Order not found' })
    const order = orderArr[0]
    if (me.role !== 'admin' && me.id !== order.buyerId && me.id !== order.farmerId) return res.status(403).json({ error: 'Forbidden' })
    const [productArr, buyerArr, farmerArr, history] = await Promise.all([
      db.select().from(productsTable).where(eq(productsTable.id, order.productId)),
      db.select().from(usersTable).where(eq(usersTable.id, order.buyerId)),
      db.select().from(usersTable).where(eq(usersTable.id, order.farmerId)),
      db.select().from(orderStatusHistoryTable).where(eq(orderStatusHistoryTable.orderId, orderId)),
    ])
    const product = productArr[0]
    const buyer = buyerArr[0]
    const farmer = farmerArr[0]
    history.sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt))
    res.json({
      id: order.id,
      status: order.status,
      totalAmount: order.totalAmount,
      quantity: order.quantity,
      unitPrice: order.unitPrice,
      notes: order.notes,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      product: product ? (() => {
        const thumbs = Array.isArray(product.thumbnails) ? product.thumbnails : []
        const imgs = Array.isArray(product.images) ? product.images : []
        const hashes = Array.isArray(product.imageBlurhashes) ? product.imageBlurhashes : []
        const firstUrl = (thumbs[0] || imgs[0]) || null
        const firstHash = (hashes[0]) || null
        return { id: product.id, title: product.title, unit: product.unit, price: product.price, imageUrl: firstUrl, imageBlurhash: firstHash }
      })() : null,
      buyer: buyer ? { id: buyer.id, fullName: buyer.fullName || buyer.username } : null,
      farmer: farmer ? { id: farmer.id, fullName: farmer.fullName || farmer.username } : null,
      history: history.map(h => ({ id: h.id, fromStatus: h.fromStatus, toStatus: h.toStatus, changedByUserId: h.changedByUserId, createdAt: h.createdAt }))
    })
  } catch (e) { console.error('Error fetching order detail:', e); res.status(500).json({ error: 'Failed to fetch order detail' }) }
})

export default router