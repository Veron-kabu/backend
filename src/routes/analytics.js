import { Router } from 'express'

const router = Router()

// Minimal analytics ingestion endpoint - logs only (extend with DB/table later)
router.post('/analytics/events', async (req,res) => {
  try {
    const events = Array.isArray(req.body?.events) ? req.body.events : []
    if (!events.length) return res.json({ accepted: 0 })
    // Logging suppressed unless explicitly enabled via LOG_ANALYTICS=true
    if (process.env.LOG_ANALYTICS === 'true') {
      console.log(`📊 Analytics batch (${events.length})`, events.slice(0,5))
    }
    return res.json({ accepted: events.length })
  } catch (e) {
    console.error('analytics ingest error', e)
    res.status(500).json({ error: 'ingest_failed' })
  }
})

export default router
