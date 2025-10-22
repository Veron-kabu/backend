import { clerkMiddleware, requireAuth, getAuth, clerkClient } from "@clerk/express";
import crypto from "crypto";
import { Webhook as SvixWebhook } from "svix";
import { db } from "../config/db.js";
import { usersTable } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { handleUserCreated } from "../routes/webhooks.js";

// Global middleware to attach auth (session) to req.auth
export const withClerk = clerkMiddleware();

// Route guard for protected endpoints (use directly as middleware)
export const requireUser = requireAuth;

// API-friendly guard: returns 401 JSON instead of redirecting unauthenticated requests
export function ensureAuth(options) {
	return (req, res, next) => {
		const auth = getAuth(req, options);
		if (!auth || !auth.userId) {
			return res.status(401).json({ error: "User not authenticated" });
		}
		// ensure req.auth is present for downstream handlers
		req.auth = auth;
		next();
	};
}

// Helpful re-exports so routes can import from one place
export { getAuth, clerkClient };

// Default export remains the global middleware for convenience
export default withClerk;

// Middleware to verify Clerk webhooks using Svix headers
// Expects the route to use `express.raw({ type: "application/json" })` so `req.body` is a Buffer/string
export function verifyClerkWebhook(req, res, next) {
	try {
		const secret = process.env.CLERK_WEBHOOK_SECRET;
		if (!secret) {
			return res.status(500).json({ error: "Missing CLERK_WEBHOOK_SECRET" });
		}

		const svixId = req.headers["svix-id"]; // required
		const svixTimestamp = req.headers["svix-timestamp"]; // required
		const svixSignature = req.headers["svix-signature"]; // required

		if (!svixId || !svixTimestamp || !svixSignature) {
			return res.status(400).json({ error: "Missing Svix headers" });
		}

		const raw = typeof req.body === "string"
			? req.body
			: Buffer.isBuffer(req.body)
			? req.body.toString("utf8")
			: JSON.stringify(req.body || {});

		const wh = new SvixWebhook(secret);
		const evt = wh.verify(raw, {
			"svix-id": svixId,
			"svix-timestamp": svixTimestamp,
			"svix-signature": svixSignature,
		});

		// Attach verified event and raw body
		req.rawBody = raw;
		req.clerkEvent = evt;
		next();
	} catch (err) {
		console.error("Clerk webhook verification error:", err);
		return res.status(400).json({ error: "Webhook verification failed" });
	}
}

// Middleware to ensure a DB user row exists for the authenticated Clerk user (fallback if webhook missed)
export async function ensureDbUser(req, res, next) {
	try {
		const auth = getAuth(req)
		if (!auth?.userId) return next()
		// Check if user exists in DB
		const existing = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, auth.userId))
		if (existing.length === 0) {
			// Fetch from Clerk and provision
			const clerkUser = await clerkClient.users.getUser(auth.userId)
			if (clerkUser) {
				await handleUserCreated(clerkUser)
				if (process.env.CLERK_WEBHOOK_DEBUG === 'true') {
					console.log(`[ensureDbUser] Backfilled missing user ${auth.userId}`)
				}
			}
		}
		return next()
	} catch (err) {
		console.error('ensureDbUser error:', err.message)
		return next() // do not block request; fail softly
	}
}
