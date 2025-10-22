import express from "express"
import { db } from "../config/db.js"
import { usersTable, productsTable } from "../db/schema.js"
import { and, eq, gt, inArray } from "drizzle-orm"
import { ensureAuth } from "../middleware/auth.js"
import { requireRole } from "../middleware/role.js"
import { ENV } from "../config/env.js"

// Location object contract stored in users.location (jsonb):
// { lat: number, lng: number, address?: string, city?: string, country?: string, updatedAt?: string }

const router = express.Router()

function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n)
}

function parseLatLng(rawLat, rawLng) {
  const lat = typeof rawLat === "string" ? Number(rawLat) : rawLat
  const lng = typeof rawLng === "string" ? Number(rawLng) : rawLng
  if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}

// Bounding-box for a radius (km) around a point
function boundingBox(lat, lng, radiusKm) {
  const latDegreeKm = 110.574 // km per degree latitude
  const lngDegreeKm = 111.320 * Math.cos((lat * Math.PI) / 180)
  const dLat = radiusKm / latDegreeKm
  const dLng = radiusKm / Math.max(lngDegreeKm, 1e-6)
  return {
    minLat: lat - dLat,
    maxLat: lat + dLat,
    minLng: lng - dLng,
    maxLng: lng + dLng,
  }
}

// Coarse geocell: floor(lat*res):floor(lng*res), res=10 => 0.1 degree cells
function geoCellOf(lat, lng, res = ENV.GEO_CELL_RES || 10) {
  return `${Math.floor(lat * res)}:${Math.floor(lng * res)}`
}

function neighborGeoCells(lat, lng, radiusKm, res = ENV.GEO_CELL_RES || 10) {
  // Approximate: at res=10, 1 cell latitude ~ 11km; choose range by radius
  const cellKm = 110.574 / res
  const range = Math.max(0, Math.ceil(radiusKm / Math.max(cellKm, 1)))
  const baseLat = Math.floor(lat * res)
  const baseLng = Math.floor(lng * res)
  const cells = []
  for (let dy = -range; dy <= range; dy++) {
    for (let dx = -range; dx <= range; dx++) {
      cells.push(`${baseLat + dy}:${baseLng + dx}`)
    }
  }
  return Array.from(new Set(cells))
}

// Haversine distance in kilometers
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180
  const R = 6371 // km
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

async function getMe(req) {
  const rows = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, req.auth.userId))
  return rows[0] || null
}

// Update my live location
router.patch("/api/location", ensureAuth(), async (req, res) => {
  try {
    const { lat, lng, address, city, country } = req.body || {}
    const pos = parseLatLng(lat, lng)
    if (!pos) return res.status(400).json({ error: "Valid lat and lng are required" })

    const payload = {
      lat: pos.lat,
      lng: pos.lng,
      ...(address ? { address } : {}),
      ...(city ? { city } : {}),
      ...(country ? { country } : {}),
      updatedAt: new Date().toISOString(),
    }

    const updated = await db
      .update(usersTable)
      .set({ location: payload, updatedAt: new Date() })
      .where(eq(usersTable.clerkUserId, req.auth.userId))
      .returning()

    if (!updated?.length) return res.status(404).json({ error: "User not found" })
    res.json({ location: updated[0].location })
  } catch (e) {
    console.error("/api/location update error:", e)
    res.status(500).json({ error: "Failed to update location" })
  }
})

// Get my saved location
router.get("/api/location/me", ensureAuth(), async (req, res) => {
  try {
    const me = await getMe(req)
    if (!me) return res.status(404).json({ error: "User not found" })
    res.json({ location: me.location || null })
  } catch (e) {
    console.error("/api/location/me error:", e)
    res.status(500).json({ error: "Failed to fetch location" })
  }
})

// Nearby farmers for buyers
router.get(
  "/api/location/nearby/farmers",
  ensureAuth(),
  requireRole(["buyer", "admin"]),
  async (req, res) => {
    try {
      const origin = parseLatLng(req.query.lat, req.query.lng)
      let center = origin
      if (!center) {
        const me = await getMe(req)
        const loc = me?.location
        if (loc && isFiniteNumber(loc.lat) && isFiniteNumber(loc.lng)) {
          center = { lat: Number(loc.lat), lng: Number(loc.lng) }
        }
      }
      if (!center) return res.status(400).json({ error: "Provide lat&lng or set your location first" })

      const radiusKm = (() => {
        const r = Number(req.query.radiusKm)
        if (!Number.isFinite(r) || r <= 0) return 25
        return Math.min(r, 200) // cap
      })()
      const limit = (() => {
        const n = Number(req.query.limit)
        if (!Number.isFinite(n) || n <= 0) return 20
        return Math.min(n, 100)
      })()

      const cells = neighborGeoCells(center.lat, center.lng, radiusKm, 10)
      const farmers = await db
        .select()
        .from(usersTable)
        .where(
          and(
            eq(usersTable.role, "farmer"),
            eq(usersTable.status, "active"),
            cells.length ? inArray(usersTable.geoCell, cells) : eq(usersTable.role, "farmer"),
          ),
        )

      const results = []
      for (const u of farmers) {
        const loc = u.location
        if (!loc) continue
        const lat = Number(loc.lat)
        const lng = Number(loc.lng)
        if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) continue
        // Fast bounding-box check before Haversine
        const box = boundingBox(center.lat, center.lng, radiusKm)
        if (lat < box.minLat || lat > box.maxLat || lng < box.minLng || lng > box.maxLng) continue
        const d = haversineKm(center.lat, center.lng, lat, lng)
        if (d <= radiusKm) {
          results.push({
            id: u.id,
            fullName: u.fullName || u.username,
            username: u.username,
            profileImageUrl: u.profileImageUrl || null,
            location: { lat, lng, address: loc.address || null, city: loc.city || null, country: loc.country || null },
            distanceKm: Number(d.toFixed(2)),
          })
        }
      }
      results.sort((a, b) => a.distanceKm - b.distanceKm)
      res.json(results.slice(0, limit))
    } catch (e) {
      console.error("/api/location/nearby/farmers error:", e)
      res.status(500).json({ error: "Failed to find nearby farmers" })
    }
  },
)

// Nearby buyers for farmers
router.get(
  "/api/location/nearby/buyers",
  ensureAuth(),
  requireRole(["farmer", "admin"]),
  async (req, res) => {
    try {
      const origin = parseLatLng(req.query.lat, req.query.lng)
      let center = origin
      if (!center) {
        const me = await getMe(req)
        const loc = me?.location
        if (loc && isFiniteNumber(loc.lat) && isFiniteNumber(loc.lng)) {
          center = { lat: Number(loc.lat), lng: Number(loc.lng) }
        }
      }
      if (!center) return res.status(400).json({ error: "Provide lat&lng or set your location first" })

      const radiusKm = (() => {
        const r = Number(req.query.radiusKm)
        if (!Number.isFinite(r) || r <= 0) return 25
        return Math.min(r, 200)
      })()
      const limit = (() => {
        const n = Number(req.query.limit)
        if (!Number.isFinite(n) || n <= 0) return 20
        return Math.min(n, 100)
      })()

      const cells = neighborGeoCells(center.lat, center.lng, radiusKm, 10)
      const buyers = await db
        .select()
        .from(usersTable)
        .where(
          and(
            eq(usersTable.role, "buyer"),
            eq(usersTable.status, "active"),
            cells.length ? inArray(usersTable.geoCell, cells) : eq(usersTable.role, "buyer"),
          ),
        )

      const results = []
      for (const u of buyers) {
        const loc = u.location
        if (!loc) continue
        const lat = Number(loc.lat)
        const lng = Number(loc.lng)
        if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) continue
        const d = haversineKm(center.lat, center.lng, lat, lng)
        if (d <= radiusKm) {
          results.push({
            id: u.id,
            fullName: u.fullName || u.username,
            username: u.username,
            profileImageUrl: u.profileImageUrl || null,
            location: { lat, lng, address: loc.address || null, city: loc.city || null, country: loc.country || null },
            distanceKm: Number(d.toFixed(2)),
          })
        }
      }
      results.sort((a, b) => a.distanceKm - b.distanceKm)
      res.json(results.slice(0, limit))
    } catch (e) {
      console.error("/api/location/nearby/buyers error:", e)
      res.status(500).json({ error: "Failed to find nearby buyers" })
    }
  },
)

// Nearby products (farmer listings) for buyers
router.get(
  "/api/location/nearby/products",
  ensureAuth(),
  requireRole(["buyer", "admin"]),
  async (req, res) => {
    try {
      const origin = parseLatLng(req.query.lat, req.query.lng)
      let center = origin
      if (!center) {
        const me = await getMe(req)
        const loc = me?.location
        if (loc && isFiniteNumber(loc.lat) && isFiniteNumber(loc.lng)) {
          center = { lat: Number(loc.lat), lng: Number(loc.lng) }
        }
      }
      if (!center) return res.status(400).json({ error: "Provide lat&lng or set your location first" })

      const radiusKm = (() => {
        const r = Number(req.query.radiusKm)
        if (!Number.isFinite(r) || r <= 0) return 25
        return Math.min(r, 200)
      })()
      const limit = (() => {
        const n = Number(req.query.limit)
        if (!Number.isFinite(n) || n <= 0) return 30
        return Math.min(n, 100)
      })()
      const category = req.query.category ? String(req.query.category) : null

      // Base query: active products with stock
      const cells = neighborGeoCells(center.lat, center.lng, radiusKm, 10)
      let base = await db
        .select()
        .from(productsTable)
        .where(
          and(
            eq(productsTable.status, "active"),
            gt(productsTable.quantityAvailable, 0),
            cells.length ? inArray(productsTable.geoCell, cells) : eq(productsTable.status, "active"),
          ),
        )

      if (category) base = base.filter((p) => p.category === category)

      const results = []
      for (const p of base) {
        const loc = p.location
        if (!loc) continue
        const lat = Number(loc.lat)
        const lng = Number(loc.lng)
        if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) continue
  // Fast bounding-box check before Haversine
  const box = boundingBox(center.lat, center.lng, radiusKm)
  if (lat < box.minLat || lat > box.maxLat || lng < box.minLng || lng > box.maxLng) continue
  const d = haversineKm(center.lat, center.lng, lat, lng)
        if (d <= radiusKm) {
          results.push({
            id: p.id,
            title: p.title,
            price: p.price,
            unit: p.unit,
            images: p.images,
            location: { lat, lng, address: loc.address || null, city: loc.city || null, country: loc.country || null },
            distanceKm: Number(d.toFixed(2)),
            farmerId: p.farmerId,
            category: p.category,
            quantityAvailable: p.quantityAvailable,
            isOrganic: !!p.isOrganic,
          })
        }
      }
      results.sort((a, b) => a.distanceKm - b.distanceKm)
      res.json(results.slice(0, limit))
    } catch (e) {
      console.error("/api/location/nearby/products error:", e)
      res.status(500).json({ error: "Failed to find nearby products" })
    }
  },
)

// Public: fetch a user's location by numeric id (auth required to prevent scraping)
router.get("/api/location/user/:id", ensureAuth(), async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid user id" })
    const rows = await db.select().from(usersTable).where(eq(usersTable.id, id))
    if (!rows?.length) return res.status(404).json({ error: "User not found" })
    const u = rows[0]
    const loc = u.location || null
    res.json({ id: u.id, role: u.role, location: loc })
  } catch (e) {
    console.error("/api/location/user/:id error:", e)
    res.status(500).json({ error: "Failed to fetch user location" })
  }
})

export default router
