import { Router } from 'express'
import { db } from '../config/db.js' 
import { ensureAuth } from '../middleware/auth.js'
import { requireRole } from '../middleware/role.js'
import { requireNotSuspended } from '../middleware/status.js'
import { ordersTable, reviewsTable, usersTable, productsTable, reviewCommentsTable } from '../db/schema.js'
import { eq, and, desc, inArray } from 'drizzle-orm'
import { createNotification } from '../utils/notifications.js'

const router = Router()

// Create a review after delivery by the counterparty (not the seller of the product)
router.post('/reviews', ensureAuth(), requireNotSuspended(), async (req, res) => {
  try {
  const { order_id, product_id, rating, comment } = req.body || {}
    const orderId = order_id !== undefined ? Number(order_id) : null
    const productId = product_id !== undefined ? Number(product_id) : null
    const stars = Number(rating)
    if (!Number.isFinite(stars) || stars < 1 || stars > 5) return res.status(400).json({ error: 'rating must be 1..5' })
    // Resolve current user
    const meArr = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    if (!meArr.length) return res.status(403).json({ error: 'Unauthorized' })
    const me = meArr[0]
    let reviewedId = null
    let inserted = null
    if (Number.isFinite(orderId)) {
      const orderArr = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId))
      if (!orderArr.length) return res.status(404).json({ error: 'Order not found' })
      const order = orderArr[0]
      if (String(order.status).toLowerCase() !== 'delivered') return res.status(400).json({ error: 'Order not delivered yet' })
      if (me.id === order.farmerId) return res.status(403).json({ error: 'Seller cannot review own order' })
      if (me.id !== order.buyerId) return res.status(403).json({ error: 'Only the buyer of this order can review' })
      reviewedId = order.farmerId
      const existing = await db.select().from(reviewsTable).where(and(eq(reviewsTable.orderId, orderId), eq(reviewsTable.reviewerId, me.id)))
      if (existing.length) return res.status(409).json({ error: 'You already reviewed this order' })
      inserted = await db.insert(reviewsTable).values({ orderId, productId: order.productId, reviewerId: me.id, reviewedId, rating: stars, comment: comment || null }).returning()
    } else if (Number.isFinite(productId)) {
      // Open review path: allow rating a farmer by product, not tied to an order
      const prodArr = await db.select().from(productsTable).where(eq(productsTable.id, productId))
      if (!prodArr.length) return res.status(404).json({ error: 'Product not found' })
      const prod = prodArr[0]
      reviewedId = prod.farmerId
      if (me.id === reviewedId) return res.status(403).json({ error: 'You cannot review your own product' })
      // Prevent multiple quick-spam reviews from same reviewer for same farmer via optional soft rule: limit 1 per day
      const existing = await db.execute(`SELECT id FROM reviews WHERE reviewer_id = ${me.id} AND reviewed_id = ${reviewedId} AND created_at > NOW() - INTERVAL '1 day' LIMIT 1`)
      if (Array.isArray(existing) && existing.length) return res.status(429).json({ error: 'You recently reviewed this seller. Try again later.' })
      inserted = await db.insert(reviewsTable).values({ orderId: null, productId, reviewerId: me.id, reviewedId, rating: stars, comment: comment || null }).returning()
    } else {
      return res.status(400).json({ error: 'Provide order_id or product_id' })
    }
    // Update seller aggregate stats
    const sellerArr = await db.select().from(usersTable).where(eq(usersTable.id, reviewedId))
    if (sellerArr.length) {
      const seller = sellerArr[0]
      const nextCount = (seller.ratingCount || 0) + 1
      const sum = Number(seller.ratingAvg || 0) * Number(seller.ratingCount || 0) + stars
      const nextAvg = (sum / nextCount).toFixed(2)
      await db.update(usersTable).set({ ratingAvg: nextAvg, ratingCount: nextCount, updatedAt: new Date() }).where(eq(usersTable.id, reviewedId))
    }
    const row = inserted[0]
    // Notify the product owner (farmer)
    await createNotification(db, {
      userId: reviewedId,
      type: 'review_created',
      title: 'New review received',
      body: `${me.fullName || me.username || 'A user'} rated you ${stars} star${stars===1?'':'s'}.`,
      data: { reviewId: row.id, productId: row.productId || null, rating: stars },
    })
    return res.json(row)
  } catch (e) {
    console.error('create review failed', e)
    return res.status(500).json({ error: 'Failed to create review' })
  }
})

// Public: list reviews for a user
router.get('/users/:id/reviews', async (req, res) => {
  try {
    const userId = Number(req.params.id)
    if (!Number.isFinite(userId)) return res.status(400).json({ error: 'Invalid user id' })
    const { include } = req.query || {}
    const includeComments = typeof include === 'string' && include.split(',').includes('comments')
    // Join with reviewer for display name
    const rows = await db.select({
      id: reviewsTable.id,
      orderId: reviewsTable.orderId,
      productId: reviewsTable.productId,
      reviewerId: reviewsTable.reviewerId,
      reviewedId: reviewsTable.reviewedId,
      rating: reviewsTable.rating,
      comment: reviewsTable.comment,
      createdAt: reviewsTable.createdAt,
      reviewerName: usersTable.fullName,
      reviewerUsername: usersTable.username,
    })
    .from(reviewsTable)
    .leftJoin(usersTable, eq(reviewsTable.reviewerId, usersTable.id))
    .where(eq(reviewsTable.reviewedId, userId))
    .orderBy(desc(reviewsTable.createdAt))

    // Attach comments or count
    const reviewIds = rows.map(r => r.id)
    let commentsByReview = {}
    if (reviewIds.length > 0) {
      const allComments = await db.select({
        id: reviewCommentsTable.id,
        reviewId: reviewCommentsTable.reviewId,
        authorUserId: reviewCommentsTable.authorUserId,
        comment: reviewCommentsTable.comment,
        createdAt: reviewCommentsTable.createdAt,
        authorName: usersTable.fullName,
        authorUsername: usersTable.username,
      }).from(reviewCommentsTable).leftJoin(usersTable, eq(reviewCommentsTable.authorUserId, usersTable.id)).where(inArray(reviewCommentsTable.reviewId, reviewIds))
      if (includeComments) {
        for (const c of allComments) {
          if (!commentsByReview[c.reviewId]) commentsByReview[c.reviewId] = []
          commentsByReview[c.reviewId].push(c)
        }
        // Sort comments oldest-first for thread readability
        for (const k of Object.keys(commentsByReview)) commentsByReview[k].sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt))
      } else {
        for (const c of allComments) commentsByReview[c.reviewId] = (commentsByReview[c.reviewId] || 0) + 1
      }
    }
    const items = rows.map(r => includeComments
      ? ({ ...r, comments: commentsByReview[r.id] || [], commentsCount: (commentsByReview[r.id] || []).length })
      : ({ ...r, commentsCount: commentsByReview[r.id] || 0 })
    )
    return res.json({ items, total: items.length })
  } catch (e) {
    console.error('list user reviews failed', e)
    return res.status(500).json({ error: 'Failed to fetch reviews' })
  }
})

// Get a single review with reviewer identity
router.get('/reviews/:id', async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid review id' })
    const rows = await db.select({
      id: reviewsTable.id,
      orderId: reviewsTable.orderId,
      productId: reviewsTable.productId,
      reviewerId: reviewsTable.reviewerId,
      reviewedId: reviewsTable.reviewedId,
      rating: reviewsTable.rating,
      comment: reviewsTable.comment,
      createdAt: reviewsTable.createdAt,
      reviewerName: usersTable.fullName,
      reviewerUsername: usersTable.username,
    })
    .from(reviewsTable)
    .leftJoin(usersTable, eq(reviewsTable.reviewerId, usersTable.id))
    .where(eq(reviewsTable.id, id))
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    return res.json(rows[0])
  } catch (e) {
    console.error('get review failed', e)
    return res.status(500).json({ error: 'Failed to fetch review' })
  }
})

// List comments for a review
router.get('/reviews/:id/comments', async (req, res) => {
  try {
    const reviewId = Number(req.params.id)
    if (!Number.isFinite(reviewId)) return res.status(400).json({ error: 'Invalid review id' })
    const rows = await db.select({
      id: reviewCommentsTable.id,
      reviewId: reviewCommentsTable.reviewId,
      authorUserId: reviewCommentsTable.authorUserId,
      comment: reviewCommentsTable.comment,
      createdAt: reviewCommentsTable.createdAt,
      authorName: usersTable.fullName,
      authorUsername: usersTable.username,
    })
    .from(reviewCommentsTable)
    .leftJoin(usersTable, eq(reviewCommentsTable.authorUserId, usersTable.id))
    .where(eq(reviewCommentsTable.reviewId, reviewId))
    .orderBy(desc(reviewCommentsTable.createdAt))
    return res.json({ items: rows, total: rows.length })
  } catch (e) {
    console.error('list review comments failed', e)
    return res.status(500).json({ error: 'Failed to fetch review comments' })
  }
})

// Add a comment (reply) to a review (any authenticated user)
router.post('/reviews/:id/comments', ensureAuth(), requireNotSuspended(), async (req, res) => {
  try {
    const reviewId = Number(req.params.id)
    const { comment } = req.body || {}
    if (!Number.isFinite(reviewId)) return res.status(400).json({ error: 'Invalid review id' })
    if (!comment || String(comment).trim().length === 0) return res.status(400).json({ error: 'Comment is required' })
    const meArr = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
    if (!meArr.length) return res.status(403).json({ error: 'Unauthorized' })
    const me = meArr[0]
    const reviewArr = await db.select().from(reviewsTable).where(eq(reviewsTable.id, reviewId))
    if (!reviewArr.length) return res.status(404).json({ error: 'Review not found' })
    const review = reviewArr[0]
    const inserted = await db.insert(reviewCommentsTable).values({ reviewId, authorUserId: me.id, comment: String(comment).trim() }).returning()
    // Notify the product owner (farmer) and original reviewer (if not the same person)
    await createNotification(db, {
      userId: review.reviewedId,
      type: 'review_commented',
      title: 'New comment on a review',
      body: `${me.fullName || me.username || 'A user'} commented on a review.`,
      data: { reviewId, commentId: inserted[0].id },
    })
    if (review.reviewerId && review.reviewerId !== review.reviewedId) {
      await createNotification(db, {
        userId: review.reviewerId,
        type: 'review_commented',
        title: 'Someone replied to your review',
        body: `${me.fullName || me.username || 'A user'} replied to your review.`,
        data: { reviewId, commentId: inserted[0].id },
      })
    }
    return res.json(inserted[0])
  } catch (e) {
    console.error('create review comment failed', e)
    return res.status(500).json({ error: 'Failed to add comment' })
  }
})

// Admin: delete a single review comment
router.delete('/admin/reviews/comments/:id', ensureAuth(), requireRole(['admin']), async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid comment id' })
    const rows = await db.select().from(reviewCommentsTable).where(eq(reviewCommentsTable.id, id))
    if (!rows.length) return res.status(404).json({ error: 'Comment not found' })
    await db.delete(reviewCommentsTable).where(eq(reviewCommentsTable.id, id))
    return res.json({ ok: true })
  } catch (e) {
    console.error('admin delete comment failed', e)
    return res.status(500).json({ error: 'Failed to delete comment' })
  }
})

// Admin: bulk delete review comments by ids
router.post('/admin/reviews/comments/bulk-delete', ensureAuth(), requireRole(['admin']), async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(n => Number.isFinite(n)) : []
    if (!ids.length) return res.status(400).json({ error: 'No ids provided' })
    await db.delete(reviewCommentsTable).where(inArray(reviewCommentsTable.id, ids))
    return res.json({ ok: true, deleted: ids.length })
  } catch (e) {
    console.error('admin bulk delete comments failed', e)
    return res.status(500).json({ error: 'Failed to bulk delete comments' })
  }
})

// Admin delete review
router.delete('/admin/reviews/:id', ensureAuth(), requireRole(['admin']), async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid review id' })
    const rows = await db.select().from(reviewsTable).where(eq(reviewsTable.id, id))
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    await db.delete(reviewsTable).where(eq(reviewsTable.id, id))
    return res.json({ ok: true })
  } catch (e) {
    console.error('admin delete review failed', e)
    return res.status(500).json({ error: 'Failed to delete review' })
  }
})

// Public: list reviews for a product
router.get('/products/:id/reviews', async (req, res) => {
  try {
    const productId = Number(req.params.id)
    if (!Number.isFinite(productId)) return res.status(400).json({ error: 'Invalid product id' })
    const { include } = req.query || {}
    const includeComments = typeof include === 'string' && include.split(',').includes('comments')
    const rows = await db.select({
      id: reviewsTable.id,
      orderId: reviewsTable.orderId,
      productId: reviewsTable.productId,
      reviewerId: reviewsTable.reviewerId,
      reviewedId: reviewsTable.reviewedId,
      rating: reviewsTable.rating,
      comment: reviewsTable.comment,
      createdAt: reviewsTable.createdAt,
      reviewerName: usersTable.fullName,
      reviewerUsername: usersTable.username,
    })
    .from(reviewsTable)
    .leftJoin(usersTable, eq(reviewsTable.reviewerId, usersTable.id))
    .where(eq(reviewsTable.productId, productId))
    .orderBy(desc(reviewsTable.createdAt))

    // Attach comments or count
    const reviewIds = rows.map(r => r.id)
    let commentsByReview = {}
    if (reviewIds.length > 0) {
      const allComments = await db.select({
        id: reviewCommentsTable.id,
        reviewId: reviewCommentsTable.reviewId,
        authorUserId: reviewCommentsTable.authorUserId,
        comment: reviewCommentsTable.comment,
        createdAt: reviewCommentsTable.createdAt,
        authorName: usersTable.fullName,
        authorUsername: usersTable.username,
      }).from(reviewCommentsTable).leftJoin(usersTable, eq(reviewCommentsTable.authorUserId, usersTable.id)).where(inArray(reviewCommentsTable.reviewId, reviewIds))
      if (includeComments) {
        for (const c of allComments) {
          if (!commentsByReview[c.reviewId]) commentsByReview[c.reviewId] = []
          commentsByReview[c.reviewId].push(c)
        }
        for (const k of Object.keys(commentsByReview)) commentsByReview[k].sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt))
      } else {
        for (const c of allComments) commentsByReview[c.reviewId] = (commentsByReview[c.reviewId] || 0) + 1
      }
    }
    const items = rows.map(r => includeComments
      ? ({ ...r, comments: commentsByReview[r.id] || [], commentsCount: (commentsByReview[r.id] || []).length })
      : ({ ...r, commentsCount: commentsByReview[r.id] || 0 })
    )
    return res.json({ items, total: items.length })
  } catch (e) {
    console.error('list product reviews failed', e)
    return res.status(500).json({ error: 'Failed to fetch product reviews' })
  }
})

export default router
