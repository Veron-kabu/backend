import fs from 'fs'
import path from 'path'
import { auditLogsTable } from '../db/schema.js'

const AUDIT_DIR = path.join(process.cwd(), 'data')
const AUDIT_FILE = path.join(AUDIT_DIR, 'audit.log')
fs.mkdirSync(AUDIT_DIR, { recursive: true })

export async function writeAudit(db, event) {
  const rec = {
    ...event,
    createdAt: new Date().toISOString(),
  }
  // Attempt DB first
  let dbWritten = false
  try {
    if (db && auditLogsTable) {
      await db.insert(auditLogsTable).values({
        actorUserId: event.actorUserId || null,
        action: String(event.action || 'unknown'),
        subjectType: String(event.subjectType || 'unknown'),
        subjectId: event.subjectId ? String(event.subjectId) : null,
        details: event.details || null,
        createdAt: new Date(),
      })
      dbWritten = true
    }
  } catch (_) {}
  // Fallback to file log
  try {
    const line = JSON.stringify(rec) + '\n'
    fs.appendFileSync(AUDIT_FILE, line, 'utf8')
  } catch (_) {
    // ignore
  }
  return { dbWritten }
}
