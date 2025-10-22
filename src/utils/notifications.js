import { userNotificationsTable } from "../db/schema.js"
import { eq, desc } from 'drizzle-orm'

export async function createNotification(db, { userId, type, title, body, data }) {
  if (!userId || !type || !title) return null
  try {
    const rows = await db
      .insert(userNotificationsTable)
      .values({ userId, type, title, body: body || null, data: data || {}, createdAt: new Date() })
      .returning()
    return rows?.[0] || null
  } catch {
    return null
  }
}

export async function listUserNotifications(db, userId, { limit = 50, includeRead = false } = {}) {
  try {
    // Order newest-first at the DB level for efficiency
    const rows = await db
      .select()
      .from(userNotificationsTable)
      .where(eq(userNotificationsTable.userId, userId))
      .orderBy(desc(userNotificationsTable.createdAt))
    const filtered = includeRead ? rows : rows.filter(n => !n.readAt)
    return filtered.slice(0, Math.max(1, Math.min(200, Number(limit))))
  } catch {
    return []
  }
}

export async function markNotificationRead(db, id, userId) {
  try {
    const all = await db.select().from(userNotificationsTable)
    const rec = all.find(n => n.id === Number(id) && n.userId === userId)
    if (!rec) return null
    const now = new Date()
    await db.update(userNotificationsTable).set({ readAt: now }).where(eq(userNotificationsTable.id, rec.id))
    return { ...rec, readAt: now }
  } catch {
    return null
  }
}

export async function deleteNotification(db, id, userId) {
  try {
    const all = await db.select().from(userNotificationsTable)
    const rec = all.find(n => n.id === Number(id) && n.userId === userId)
    if (!rec) return false
    await db.delete(userNotificationsTable).where(eq(userNotificationsTable.id, rec.id))
    return true
  } catch {
    return false
  }
}
