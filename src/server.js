import express from "express"
import compression from "compression"
import cors from "cors"
import "dotenv/config"
import { db } from "./config/db.js"
import withClerk, { requireUser, getAuth, clerkClient, ensureDbUser } from "./middleware/auth.js"
import protectRoutes from "./middleware/protect.js"
import { ENV, validateEnv } from "./config/env.js"
import cronJob, { blurhashBackfillJob, orphanProductImageCleanupJob, cleanupExpiredCodesTokensJob, dailyDigestJob } from "./config/cron.js"
import { usersTable } from "./db/schema.js"
import { eq, like } from "drizzle-orm"
import locationRouter from "./models/location.js"
import userRoutes from './routes/users.js'
import productRoutes from './routes/products.js'
import uploadRoutes from './routes/uploads.js'
import orderRoutes from './routes/orders.js'
import blurhashRoutes from './routes/blurhash.js'
import miscRoutes from './routes/misc.js'
import webhookRoutes from './routes/webhooks.js'
import favoritesRoutes from './routes/favorites.js'
import analyticsRoutes from './routes/analytics.js'
import earningsRoutes from './routes/earnings.js'
import verificationRoutes from './routes/verification.js'
import reviewRoutes from './routes/reviews.js'
import reportRoutes from './routes/reports.js'
import { syncClerkUsers } from './utils/clerkSync.js'
import cron from 'cron'

// 1) Validate environment up‑front so we fail fast on misconfiguration
try {
  validateEnv()
  console.log("✅ Environment variables validated successfully")
} catch (error) {
  console.error("❌ Environment validation failed:", error.message)
  process.exit(1)
}

const app = express()
const PORT = ENV.PORT

// Response compression to reduce payload size and improve perceived latency over mobile networks
app.use(compression())

app.use(
  cors({
    origin: ENV.ALLOWED_ORIGINS,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "svix-id", "svix-timestamp", "svix-signature"],
  }),
)

// 2) Global JSON body parsing (10 MB)
//    Skip: (a) Clerk webhook (needs raw body for signature) (b) profile update (uses larger limit inside its router)
app.use((req, res, next) => {
  // Skip raw body for Clerk webhook, and skip forcing JSON parser for profile so the router can choose per method.
  if (req.path === "/api/webhooks/clerk" || req.path === "/api/users/profile") return next()
  return express.json({ limit: "10mb", type: "application/json" })(req, res, next)
})

// 3) Auth context (must precede any router using ensureAuth / getAuth) + ensure DB user fallback
app.use(withClerk)
app.use(ensureDbUser)

// 4) Feature routers (all mounted under /api). Each router owns its own concern.
//    Add new domain routers here to keep this file small.
app.use('/api', uploadRoutes)
app.use('/api', userRoutes)
app.use('/api', productRoutes)
app.use('/api', orderRoutes)
app.use('/api', blurhashRoutes)
app.use('/api', favoritesRoutes)
app.use('/api', analyticsRoutes)
app.use('/api', earningsRoutes)
app.use('/api', verificationRoutes)
app.use('/api', reviewRoutes)
app.use('/api', reportRoutes)
app.use('/api', miscRoutes)
app.use('/api', webhookRoutes)
//    Location router not namespaced (legacy path design) — can be migrated later if desired.

// Lightweight health endpoint for uptime checks and keep-alive pings
app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime(), env: ENV.NODE_ENV })
})

// 5) Background jobs (production only) + optional Clerk automation (any env)
if (ENV.NODE_ENV === "production") {
  cronJob.start()
  blurhashBackfillJob.start()
  orphanProductImageCleanupJob.start()
  cleanupExpiredCodesTokensJob.start()
  dailyDigestJob.start()
  console.log("🕐 Cron jobs started: keep-alive, blurhash backfill, orphan image cleanup, expired code/token cleanup, daily digest")
}

// 5a) Optional one-time Clerk user sync on server start (any environment)
;(async function optionalStartupClerkSync() {
  if (process.env.CLERK_AUTO_SYNC_ON_START === 'true') {
    try {
      const verbose = process.env.CLERK_WEBHOOK_DEBUG === 'true'
      if (verbose) console.log('[clerk:sync] Startup sync beginning')
      await syncClerkUsers({ verbose })
      if (verbose) console.log('[clerk:sync] Startup sync complete')
    } catch (e) {
      console.error('[clerk:sync] Startup sync failed (non-fatal):', e.message)
    }
  }
})()

// 5b) Optional periodic Clerk sync (works in dev or prod). Two ways to enable:
//     - Set CLERK_PERIODIC_SYNC_CRON (cron expression)
//     - Or set CLERK_PERIODIC_SYNC_ENABLE=true to default to hourly
;(function optionalPeriodicClerkSync() {
  const enabled = process.env.CLERK_PERIODIC_SYNC_CRON || process.env.CLERK_PERIODIC_SYNC_ENABLE === 'true'
  if (!enabled) return
  const cronExpr = process.env.CLERK_PERIODIC_SYNC_CRON || '0 * * * *' // default hourly
  try {
    const job = new cron.CronJob(cronExpr, async () => {
      try {
        const verbose = process.env.CLERK_WEBHOOK_DEBUG === 'true'
        if (verbose) console.log('[clerk:sync] Periodic sync started')
        await syncClerkUsers({ verbose })
        if (verbose) console.log('[clerk:sync] Periodic sync finished')
      } catch (err) {
        console.error('[clerk:sync] Periodic sync failed:', err.message)
      }
    })
    job.start()
    console.log(`🔁 Clerk periodic sync enabled (cron: ${cronExpr})`)
  } catch (e) {
    console.error('Failed to initialize periodic Clerk sync cron:', e.message)
  }
})()

// 6) Route protection patterns
//    a) Browser routes under /protected -> redirect if not authenticated
//    b) API namespaces -> respond 401 JSON when not authorized
app.use(protectRoutes(["/protected(.*)"], { mode: "redirect" }))
app.use(protectRoutes(["/api/admin(.*)", "/api/secure(.*)"], { mode: "api" }))

// 7) Non-namespaced legacy location routes (consider moving under /api later)
app.use(locationRouter)

// 8) End of core server bootstrap. Webhook + feature logic lives in /routes/*.js
//    Keep this file focused on wiring, not business logic.

// 8a) One-time startup maintenance tasks (non-blocking)
//     - Cleanup any legacy / placeholder banner URLs that pointed at example CloudFront domains.
//       These cause broken images & repeated resolve attempts on clients. We null them so the
//       client knows to show a placeholder & prompt re-upload.
;(async function startupMaintenance() {
  try {
    const PLACEHOLDER_PATTERN = '%your-cloudfront-domain%'
    const bannerCleaned = await db
      .update(usersTable)
      .set({ bannerImageUrl: null })
      .where(like(usersTable.bannerImageUrl, PLACEHOLDER_PATTERN))
      .returning({ id: usersTable.id })

    const avatarCleaned = await db
      .update(usersTable)
      .set({ profileImageUrl: null })
      .where(like(usersTable.profileImageUrl, PLACEHOLDER_PATTERN))
      .returning({ id: usersTable.id })

    if (process.env.LOG_STARTUP_CLEANUP_LOGS === 'true') {
      if (bannerCleaned.length > 0 || avatarCleaned.length > 0) {
        console.log(`🧹 Startup cleanup: cleared ${bannerCleaned.length} banner and ${avatarCleaned.length} avatar placeholder URL(s)`)
      } else {
        console.log('🧹 Startup cleanup: no placeholder banner/avatar URLs found')
      }
    }
  } catch (e) {
    console.error('⚠️  Startup banner cleanup failed (non-fatal):', e.message)
  }
})()

// 9) Start HTTP server (only if executed directly, not when imported for tests / scripts)
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`🚀 API server listening on port ${PORT} (env: ${ENV.NODE_ENV})`)
  })
}

export default app
