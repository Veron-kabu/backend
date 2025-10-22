import { verificationStatusHistoryTable } from "../db/schema.js"

export async function writeStatusHistory(db, { submissionId, fromStatus, toStatus, actorUserId, note }) {
  if (!submissionId || !toStatus) return null
  try {
    const rows = await db.insert(verificationStatusHistoryTable).values({
      submissionId,
      fromStatus: fromStatus || null,
      toStatus,
      actorUserId: actorUserId || null,
      note: note || null,
      createdAt: new Date(),
    }).returning()
    return rows?.[0] || null
  } catch {
    return null
  }
}
