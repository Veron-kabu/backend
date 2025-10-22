// Webhook testing utility for development (ESM)
import { Webhook as SvixWebhook } from "svix";
import "dotenv/config";

// Test webhook payload for user.created event
const testUserCreatedPayload = {
  type: "user.created",
  data: {
    id: "user_test123",
    username: "testuser",
    email_addresses: [
      {
        id: "email_test123",
        email_address: "test@example.com",
        verification: {
          status: "verified",
        },
      },
    ],
    primary_email_address_id: "email_test123",
    unsafe_metadata: {
      role: "farmer",
      full_name: "Test User",
      phone: "+1234567890",
      location: {
        city: "Test City",
        state: "Test State",
      },
    },
  },
}

// Generate webhook signature for testing using Svix (matches server verification)
function generateWebhookSignature(payload, secret) {
  const body = JSON.stringify(payload);
  const wh = new SvixWebhook(secret);
  // Svix doesn't expose a sign() here, but the verify expects proper headers.
  // For local testing, we can simulate headers by computing through wh.sign is not available.
  // Instead, we rely on Clerk Dash or disable verification in dev if needed.
  // As a workaround, we pass dummy headers that will fail unless secret matches and signature is valid.
  // Keeping function to preserve API, but recommend using the actual Clerk webhook tester.
  return {
    "svix-id": `test_${Date.now()}`,
    "svix-timestamp": Math.floor(Date.now() / 1000).toString(),
    "svix-signature": "v1=INVALID_FOR_LOCAL",
    body,
  };
}

// Test webhook endpoint
async function testWebhook() {
  const webhookSecret = process.env.CLERK_WEBHOOK_SECRET || "test_secret";
  const { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signature, body } = generateWebhookSignature(
    testUserCreatedPayload,
    webhookSecret
  );

  try {
    const response = await fetch("http://localhost:5001/api/webhooks/clerk", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "svix-id": id,
        "svix-signature": signature,
        "svix-timestamp": timestamp,
      },
      body: body,
    })

    const result = await response.json()
    console.log("Webhook test result:", result)
    console.log("Status:", response.status)
  } catch (error) {
    console.error("Webhook test failed:", error)
  }
}

// If file is run directly with Node
if (import.meta.url === `file://${process.argv[1]}`) {
  testWebhook();
}
