Backend
======

Quick start
-----------
1. Install dependencies
	npm install
2. (Optional) Dev auto-reload
	npm install --save-dev nodemon
3. Run development server
	npm run dev

	npm run sync:clerk:users

Environment Variables
---------------------
Core (already present / implied):
- PORT
- NODE_ENV
- DATABASE_URL (for Drizzle / Postgres)
- API_URL (public base URL used by keep-alive ping & some mobile calls)
- ALLOWED_ORIGINS (CSV list)

Uploads / Media (optional; enable S3 pipeline):
- AWS_ACCESS_KEY_ID
- AWS_SECRET_ACCESS_KEY
- AWS_S3_REGION
- AWS_S3_BUCKET
- AWS_S3_PUBLIC_READ=true|false (if false we sign GET URLs)
- AWS_CLOUDFRONT_DOMAIN (optional CDN domain)
- UPLOAD_MAX_MB (numeric, default fallback in code if missing)

Automated Verification:
- Removed. OCR/EXIF/classification/scoring pipelines and related environment variables are no longer used.

Blurhash / Media Optimization:
- DISABLE_AUTO_BACKFILL=true|false (default: false). When true, disables the hourly automatic blurhash backfill cron.

Cron Jobs
---------
Two cron jobs are started automatically in production (NODE_ENV=production):
1. Keep-alive ping: Every 14 minutes hits /health to keep the instance warm (useful on hosting platforms that idle apps).
2. Blurhash backfill: Minute 7 of every hour, processes a small batch (limit 15) of users/products missing blurhashes and stores them. Set DISABLE_AUTO_BACKFILL=true to turn this off.
 3. Clerk user sync (optional): If CLERK_PERIODIC_SYNC_CRON is set (e.g. "0 * * * *" for hourly), the server will periodically reconcile all Clerk users into the local DB as a safety net if webhooks are missed.

Blurhash Pipeline
-----------------
The application computes Blurhash placeholders server-side for:
- User profile images (profileImageUrl -> profileImageBlurhash)
- User banner images (bannerImageUrl -> bannerImageBlurhash)
- Product images (images[] -> imageBlurhashes[])

Workflow:
1. User uploads image to S3 via presigned URL.
2. Client optionally calls /api/utils/blurhash with the public (or signed) URL to compute hash, then PATCHes the user profile with the blurhash, OR relies on background backfill.
3. Product creation triggers an asynchronous background task that computes up to the first 6 image blurhashes with limited concurrency.
4. Hourly cron backfill fills any remaining missing hashes gradually to avoid CPU spikes.

Endpoints Summary (Blurhash-related):
- POST /api/utils/blurhash { imageUrl } -> { blurhash } (501 if sharp/encoder unavailable)
- POST /api/utils/blurhash/backfill { limit? } -> Manually trigger small batch backfill (auth required)

Client Usage
------------
Mobile components use a `BlurhashImage` wrapper (expo-image) which now supports a fade-in transition (default 400ms) and uses the blurhash as a placeholder until the actual image loads.

Rate Limiting
-------------
Product creation endpoint uses an in-memory token bucket (burst 10, refill ~1 every 4s per user) to prevent excessive simultaneous image hashing load.
For multi-instance scaling you should replace with a shared store (Redis) or disable as needed.

Backfill Strategy
-----------------
Low, continuous trickle: hourly cron + on-demand endpoint + CLI script (scripts/backfill-blurhashes.mjs) provide flexible filling of historical records without large CPU spikes.

Development Notes
-----------------
- If sharp native deps are missing in some local environments, /api/utils/blurhash will respond 501; the rest of the app continues functioning.
- Set DISABLE_AUTO_BACKFILL=true in local development if you do not want periodic hashing jobs running.

CLI Utilities
-------------
Run bulk backfill iteratively until complete:
  npm run blurhash:backfill

Future Improvements (Suggestions)
---------------------------------
- Persist rate limit counters in Redis for horizontal scaling.
- Add precomputed downscaled thumbnails to reduce bandwidth.
- Add metrics/log aggregation around hash generation time and failure rate.
 - Add alerting when webhook deliveries fail repeatedly.

Verification Endpoints (cURL Examples)
--------------------------------------
All endpoints require Clerk auth. Replace $TOKEN with a valid bearer token and $BASE with your backend URL.

- Get upload token
	```pwsh
	curl -X POST -H "Authorization: Bearer $env:TOKEN" -H "Content-Type: application/json" \
		-d '{"filename":"capture.jpg","contentType":"image/jpeg"}' \
		"$env:BASE/api/verification/upload-token"
	```
	Response: `{ uploadUrl, uploadKey, originUrl, contentType }`

- Upload file (example using Invoke-WebRequest)
	```pwsh
	Invoke-WebRequest -Method Put -InFile .\capture.jpg -ContentType 'image/jpeg' -Uri $uploadUrl
	```

- Submit verification
	```pwsh
	$body = @{
		images = @(
			@{ uploadKey = "verification/<clerkId>/..._capture_1.jpg"; lat = 0.35; lng = 32.58; accuracy = 15; altitude = 120; altitude_accuracy = 5; timestamp = (Get-Date).ToUniversalTime().ToString("o"); photo_index = 1 }
			@{ uploadKey = "verification/<clerkId>/..._capture_2.jpg"; lat = 0.35; lng = 32.58; accuracy = 15; altitude = 122; altitude_accuracy = 5; timestamp = (Get-Date).ToUniversalTime().ToString("o"); photo_index = 2 }
			@{ uploadKey = "verification/<clerkId>/..._capture_3.jpg"; lat = 0.35; lng = 32.58; accuracy = 14; altitude = 121; altitude_accuracy = 5; timestamp = (Get-Date).ToUniversalTime().ToString("o"); photo_index = 3 }
		)
		device_info = @{ platform = "iOS"; os_version = "17"; device_model = "iPhone" }
	} | ConvertTo-Json -Depth 6

	curl -X POST -H "Authorization: Bearer $env:TOKEN" -H "Content-Type: application/json" \
		-d $body "$env:BASE/api/verification/submission"
	```

Notes
-----
- The verification engine has been simplified. Automated OCR/EXIF/classification/duplicate/score checks are removed. Admins review submitted photos manually.


Clerk User Provisioning & Sync
------------------------------
Automatic provisioning now has three layers of redundancy:
1. Webhooks (Primary)
	- Endpoint: POST /api/webhooks/clerk (raw body, Svix verified)
	- Set CLERK_WEBHOOK_DEBUG=true for verbose logging of each event.
2. On-Demand Backfill (Manual / One-off)
	- Run: npm run sync:clerk:users
	- Paginates through all Clerk users and upserts them (idempotent).
3. Lazy Auto-Provision (Per Request)
	- Middleware ensureDbUser runs after auth; if an authenticated Clerk user has no DB row, it fetches from Clerk and creates it silently.

Optional Periodic Sync (Safety Net)
----------------------------------
Set an environment variable to enable: CLERK_PERIODIC_SYNC_CRON="0 * * * *" (example: hourly)
When set, the server schedules an internal job that calls the same sync logic used by the CLI script, ensuring eventual consistency even if multiple webhooks were missed.

How to Use (Clerk Sync & Debug)
-------------------------------
1. Enable Debug (optional)
	PowerShell (temporary for current session):
	  $env:CLERK_WEBHOOK_DEBUG = "true"
	  npm run dev

	Inline (one line):
	  $env:CLERK_WEBHOOK_DEBUG = "true"; npm run dev

	Persist across new shells (writes to user environment – reopen terminal after):
	  setx CLERK_WEBHOOK_DEBUG true

	IMPORTANT (Windows): Do NOT escape quotes with backslashes. This is WRONG:
	  $env:CLERK_WEBHOOK_DEBUG=\"true\"
	It will produce the `\true\ : The term '\true\' is not recognized` error you saw.
	Shows detailed webhook receipt + provisioning logs.
2. One-Off Backfill
	npm run sync:clerk:users
	- Pages through Clerk users
	- Upserts each into users table using the same logic as webhooks
3. Automatic Fallback (No Action Needed)
	- ensureDbUser middleware runs on every authenticated request
	- If the DB row is missing it creates it on the fly (debug logs when enabled)

Environment Variables (Clerk-related)
------------------------------------
- CLERK_WEBHOOK_SECRET : Verifies incoming webhooks via Svix headers
- CLERK_SECRET_KEY     : Required for server-side user listing (sync/backfill)
- CLERK_WEBHOOK_DEBUG  : When "true" prints verbose provisioning logs
- CLERK_PERIODIC_SYNC_CRON : (Optional) Cron expression enabling periodic full sync

Troubleshooting Webhooks
------------------------
1. Confirm Clerk dashboard endpoint matches your deployed URL + /api/webhooks/clerk
2. Ensure the secret in Clerk matches CLERK_WEBHOOK_SECRET in your environment
3. Enable debug and trigger a test delivery from Clerk dashboard
4. If users are still missing, run: npm run sync:clerk:users
5. Check application logs for any "Clerk webhook verification error" entries (likely signature/header mismatch)

FAQ
----
Q: Will running sync multiple times create duplicates?  
A: No. Upsert logic checks clerkUserId and updates existing rows.

Q: What if a user was soft-deleted in Clerk?  
A: user.deleted webhook sets status=inactive; periodic/one-off sync will re-activate only if Clerk still returns the user (deleted users generally won’t be returned in standard listing).

Q: Does ensureDbUser run on every request?  
A: It runs after auth; if the user already exists, it returns fast with a single select query.

Additional Verification Workflows (Manual Review & Notifications)
----------------------------------------------------------------
New endpoints:
- User notifications: GET /api/verification/my-notifications, POST /api/verification/notifications/:id/read
- Admin comments: POST /api/admin/verifications/:id/comment
- Appeals: POST /api/verification/:id/appeal, GET /api/admin/verification-appeals, POST /api/admin/verification-appeals/:id/resolve
- Two-admin config is removed. Approval is single-admin.

Behavior:
- In-app notifications are created on approve, reject, and request-more-info.
- Two-admin rule (when enabled) sets status to awaiting_second_approval on first approval; a second Approve finalizes.
- Appeals extend media retention and create an admin task (listable under admin appeals endpoints).
