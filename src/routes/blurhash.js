import { Router } from 'express'
import { ensureAuth } from '../middleware/auth.js'
import { computeBlurhashFromUrl } from '../utils/blurhash.js'
import { db } from '../config/db.js'
import { usersTable, productsTable } from '../db/schema.js'
import { eq } from 'drizzle-orm'

const router = Router()

router.post('/utils/blurhash', ensureAuth(), async (req,res) => {
  try {
    const { imageUrl } = req.body || {}
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' })
    const { hash, width, height, componentsX, componentsY } = await computeBlurhashFromUrl(imageUrl)
    res.json({ blurhash: hash, width, height, components: { x: componentsX, y: componentsY } })
  } catch (e) {
    if (e.message === 'deps_unavailable') return res.status(501).json({ error: 'blurhash dependencies not available' })
    console.error('blurhash error', e)
    res.status(500).json({ error: 'Failed to compute blurhash' })
  }
})

router.post('/utils/blurhash/backfill', ensureAuth(), async (req,res) => {
  try {
    const { limit = 20 } = req.body || {}
    const lim = Math.min(100, Math.max(1, Number(limit)))
    const users = await db.select().from(usersTable)
    const products = await db.select().from(productsTable)
    let updatedUsers = 0, updatedProducts = 0
    async function encode(url) { try { const { hash } = await computeBlurhashFromUrl(url); return hash } catch { return null } }
    for (const u of users) {
      if (updatedUsers >= lim) break
      if ((!u.profileImageUrl || u.profileImageBlurhash) && (!u.bannerImageUrl || u.bannerImageBlurhash)) continue
      const updates = {}
      if (u.profileImageUrl && !u.profileImageBlurhash) { const h = await encode(u.profileImageUrl); if (h) updates.profileImageBlurhash = h }
      if (u.bannerImageUrl && !u.bannerImageBlurhash) { const h = await encode(u.bannerImageUrl); if (h) updates.bannerImageBlurhash = h }
      if (Object.keys(updates).length) { updates.updatedAt = new Date(); await db.update(usersTable).set(updates).where(eq(usersTable.id, u.id)); updatedUsers++ }
    }
    for (const p of products) {
      if (updatedProducts >= lim) break
      if (!Array.isArray(p.images) || p.images.length === 0 || (Array.isArray(p.imageBlurhashes) && p.imageBlurhashes.length > 0)) continue
      const hashes = []
      for (const url of p.images.slice(0,6)) { const h = await encode(url); if (h) hashes.push(h) }
      if (hashes.length > 0) { await db.update(productsTable).set({ imageBlurhashes: hashes, updatedAt: new Date() }).where(eq(productsTable.id, p.id)); updatedProducts++ }
    }
    res.json({ updatedUsers, updatedProducts })
  } catch (e) {
    console.error('blurhash backfill error', e)
    res.status(500).json({ error: 'Backfill failed' })
  }
})

export default router