import express, { Router } from 'express'
import { db } from '../config/db.js'
import { usersTable } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { verifyClerkWebhook } from '../middleware/auth.js'

// Optional verbose logging toggle (set CLERK_WEBHOOK_DEBUG=true)
const DEBUG = process.env.CLERK_WEBHOOK_DEBUG === 'true'

const router = Router()

// Clerk event handlers (scoped here to keep server.js slim)
export async function handleUserCreated(userData, opts = {}) {
  // Normalize both Clerk webhook (snake_case) and Clerk SDK (camelCase) shapes
  const id = userData?.id
  const username = userData?.username
    ?? userData?.username // same key for both
  const first_name = userData?.first_name ?? userData?.firstName
  const last_name = userData?.last_name ?? userData?.lastName
  const image_url = userData?.image_url ?? userData?.imageUrl
  const unsafe_metadata = userData?.unsafe_metadata ?? userData?.unsafeMetadata ?? {}

  // Email addresses
  let email_addresses = userData?.email_addresses
  if (!Array.isArray(email_addresses) && Array.isArray(userData?.emailAddresses)) {
    email_addresses = userData.emailAddresses.map(e => ({
      id: e.id,
      email_address: e.emailAddress,
      verification: e.verification || e.verificationStatus ? { status: e.verification?.status || e.verificationStatus } : undefined,
    }))
  }
  const primary_email_address_id = userData?.primary_email_address_id ?? userData?.primaryEmailAddressId

  if (!id || !Array.isArray(email_addresses) || email_addresses.length === 0) return

  const primaryEmailObj = email_addresses.find(e => e.id === primary_email_address_id) || email_addresses[0]
  const primaryEmail = primaryEmailObj?.email_address
  const role = unsafe_metadata.role || 'buyer'
  const fullName = unsafe_metadata.full_name || [first_name, last_name].filter(Boolean).join(' ') || null
  const phone = unsafe_metadata.phone || null
  const location = unsafe_metadata.location || null
  const emailVerified = primaryEmailObj?.verification?.status === 'verified' || false
  const derivedUsername = username || (primaryEmail ? primaryEmail.split('@')[0] : `user_${id.slice(-6)}`)

  const now = new Date()
  try {
    const existing = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, id))
    if (existing.length > 0) {
      await db
        .update(usersTable)
        .set({
          username: derivedUsername,
          email: primaryEmail,
          role,
          fullName,
          phone,
          location,
          profileImageUrl: image_url || null,
          bannerImageUrl: null,
          emailVerified,
          status: 'active',
          updatedAt: now,
        })
        .where(eq(usersTable.clerkUserId, id))
      if (DEBUG) console.log(`[clerk:webhook] Updated existing user ${id} (${primaryEmail})`)
      return { action: 'updated' }
    } else {
      await db.insert(usersTable).values({
        clerkUserId: id,
        username: derivedUsername,
        email: primaryEmail,
        role,
        fullName,
        phone,
        location,
        profileImageUrl: image_url || null,
        bannerImageUrl: null,
        emailVerified,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      if (DEBUG) console.log(`[clerk:webhook] Inserted new user ${id} (${primaryEmail})`)
      return { action: 'inserted' }
    }
  } catch (e) {
    console.error('handleUserCreated error:', e)
    return { error: e }
  }
}

async function handleUserUpdated(userData) {
  const { id } = userData || {}
  if (!id) return
  return handleUserCreated(userData) // upsert logic reused
}

async function handleUserDeleted(userData) {
  const { id } = userData || {}
  if (!id) return
  try {
    await db
      .update(usersTable)
      .set({ status: 'inactive', updatedAt: new Date() })
      .where(eq(usersTable.clerkUserId, id))
    if (DEBUG) console.log(`[clerk:webhook] Soft-deactivated user ${id}`)
  } catch (e) {
    console.error('handleUserDeleted error:', e)
  }
}

// Clerk webhook endpoint (raw body for signature verification)
router.post('/webhooks/clerk', express.raw({ type: 'application/json' }), verifyClerkWebhook, async (req, res) => {
  try {
    const evt = req.clerkEvent
    if (!evt) return res.status(400).json({ error: 'Missing verified event' })
    const { type, data } = evt
    if (DEBUG) {
      console.log(`[clerk:webhook] Received ${type} (id=${data?.id || 'n/a'})`)
    }
    switch (type) {
      case 'user.created':
        await handleUserCreated(data)
        break
      case 'user.updated':
        await handleUserUpdated(data)
        break
      case 'user.deleted':
        await handleUserDeleted(data)
        break
      default:
        console.log(`Unhandled webhook type: ${type}`)
    }
    res.status(200).json({ received: true })
  } catch (error) {
    console.error('Webhook error:', error)
    res.status(500).json({ error: 'Webhook processing failed' })
  }
})

export default router
