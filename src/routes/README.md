# Routes Overview

This directory contains modular Express routers mounted under the `/api` prefix (except the location router which lives in `models/location.js` currently). Each file encapsulates a domain area. Below is a concise summary of responsibilities and primary endpoints.

> Status legend: (auth) requires a signed-in user; (role: X) restricts to given roles; (public) no auth.

---

## analytics.js
Minimal ingestion endpoint for client batched analytics.
- `POST /api/analytics/events` (public) — Accepts `{ events: [...] }`, currently logs only. Future: persist to DB / queue.

## blurhash.js
Utility endpoints for generating & backfilling Blurhash placeholders.
- `POST /api/utils/blurhash` (auth) — Compute blurhash for a single image URL.
- `POST /api/utils/blurhash/backfill` (auth) — Best-effort batch encode missing user/product images (limit param).

## favorites.js
Lightweight favorites toggle & listing (buyer context).
- `POST /api/favorites/:productId/toggle` (auth) — Toggle product favorite.
- `GET  /api/favorites/:productId/status` (auth) — Check if current user favorited product.
- `GET  /api/favorites` (auth) — List raw favorites rows for current user.

## misc.js
Mixed legacy/aux endpoints: reviews, favorites (legacy variant), farmer dashboard, market data.
- Reviews: `POST /api/reviews`, `GET /api/reviews`
- Favorites (legacy style): `POST /api/favorites`, `GET /api/favorites?buyer=me`
- Farmer dashboard: `GET /api/dashboard/farmer`
- Market data: `GET /api/market-data`
Note: favorites here overlaps with `favorites.js` (consider de‑duping later).

## orders.js
Buyer order creation & query, order status updates by farmer.
- `GET  /api/orders?buyer=me` (auth, role: buyer)
- `POST /api/orders` (auth, role: buyer)
- `PATCH /api/orders/:id/status` (auth, role: farmer|admin)
- `PATCH /api/orders/:id` (auth, role: farmer|admin) – compatibility
- `GET  /api/orders/:id` (auth, role: buyer|farmer|admin related to order) – detail with status history

Status transitions are stored in `order_status_history` (`id, order_id, from_status, to_status, changed_by_user_id, created_at`). Initial row inserted at creation; each status change appends a new row.

## products.js
Product listing, detail, creation, update & soft-delete / restore.
- `GET    /api/products` (public) — Supports category, price filters, organic flag, cursor pagination via `cursor` + `limit`.
- `GET    /api/products/:id` (public)
- `POST   /api/products` (auth, role: farmer) — Creates product with discount support & async blurhash generation.
- `PATCH  /api/products/:id` (auth, role: farmer|admin) — Update price, quantity, discount, status (subset).
- `DELETE /api/products/:id` (auth, role: farmer|admin) — Soft delete (status=inactive).
- `POST   /api/products/:id/restore` (auth, role: farmer|admin) — Restore inactive product.

## uploads.js
Presigned S3 upload flows for user media.
- `GET  /api/uploads/storage-health` (auth) — Inspect active storage mode (S3 vs CloudFront, public vs private).
- `GET  /api/uploads/debug-head?url=<originUrl>` (auth) — Probe object existence via a temporary signed URL.
- `GET  /api/uploads/avatar-signed-url` (auth) — Temporary GET presign for existing object.
- `GET  /api/uploads/resolve-avatar-url` (auth) — Generic resolver; returns signed URL for private objects.
- `POST /api/uploads/avatar-presign` (auth) — Generate PUT presign for avatar upload (prefix: `avatars/`).
- `POST /api/uploads/product-presign` (auth) — Generate PUT presign for product images (prefix: `products/`).
- `POST /api/uploads/banner-presign` (auth) — Generate PUT presign for banner upload (prefix: `banners/`).

## users.js
User creation (first-time), profile retrieval & updates, role switching, public profile subset.
- `POST /api/users` (auth)
- `GET  /api/users/profile` (auth)
- `PATCH /api/users/profile` (auth) — Supports username/email uniqueness & image host allowlist.
<!-- Role switching endpoint removed: buyer/farmer roles are fixed after creation -->
### Role Management Note
Roles are immutable after user creation (no buyer↔farmer switching). A migration (`0001_lock_roles.sql`) normalizes any legacy invalid roles back to `buyer`.
- `DELETE /api/users/banner` (auth) — Remove banner image.
- `GET  /api/users/:id` (public subset)

## webhooks.js
Clerk user lifecycle webhooks (raw body required for signature). Upserts users and marks deleted as inactive.
- `POST /api/webhooks/clerk` (public webhook) — Handles `user.created|updated|deleted`.

---

## Known Overlaps / Cleanup Candidates
- Favorites endpoints exist in both `favorites.js` and `misc.js`. Plan: consolidate into one router (`favorites.js`) and deprecate legacy variants.
- Location geo-based endpoints currently live in `models/location.js` (ESM route). Consider moving to `routes/location.js` for consistency, then update `server.js` import.
- Analytics ingestion is log-only; future: create `analytics_events` table and persist.

## Conventions
- All new domain logic should get its own router file to keep `server.js` slim.
- Prefer Drizzle schema mappings for field naming; expose API payloads in snake_case where already established.
- Add authentication middleware (`ensureAuth`) first, then `requireRole` where role scoping is needed.

## Adding a New Router
1. Create `newFeature.js` exporting an Express router.
2. Mount in `src/server.js` with `app.use('/api', newFeatureRoutes)`.
3. Document endpoints here.

---
Generated on: 2025-09-25
