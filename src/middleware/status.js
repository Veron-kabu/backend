import { db } from "../config/db.js"
import { usersTable } from "../db/schema.js"
import { eq } from "drizzle-orm"
import { clerkClient } from "./auth.js"

// Blocks suspended users from performing write actions.
// If allowAdminBypass is true, admins are allowed through even if their DB status is suspended.
export function requireNotSuspended({ allowAdminBypass = true } = {}) {
  return async (req, res, next) => {
    try {
      const clerkId = req?.auth?.userId
      if (!clerkId) return res.status(401).json({ error: "Unauthorized" })

      // Load DB user (and cache dbUserId for downstream routes)
      let meRows = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, clerkId))
      const me = meRows?.[0]
      if (!me) return res.status(403).json({ error: "Access denied" })
      req.auth.dbUserId = me.id

      // Determine role (prefer Clerk metadata, fallback to DB)
      let role = null
      try {
        const cu = await clerkClient.users.getUser(clerkId)
        role = cu?.unsafeMetadata?.role || null
      } catch {}
      if (!role) role = me.role

      if (allowAdminBypass && role === 'admin') return next()

      if (String(me.status).toLowerCase() === 'suspended') {
        return res.status(403).json({ error: 'Account suspended. Action blocked.', code: 'SUSPENDED' })
      }
      return next()
    } catch (e) {
      console.error('requireNotSuspended error', e)
      return res.status(500).json({ error: 'Internal error' })
    }
  }
}

export default requireNotSuspended
