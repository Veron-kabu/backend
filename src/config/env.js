import "dotenv/config"

export const ENV = {
  PORT: process.env.PORT || 5001,
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV || "development",

  // Clerk Authentication
  CLERK_PUBLISHABLE_KEY: process.env.CLERK_PUBLISHABLE_KEY,
  CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
  CLERK_WEBHOOK_SECRET: process.env.CLERK_WEBHOOK_SECRET,

  // API Configuration
  API_URL: process.env.API_URL || `http://localhost:${process.env.PORT || 5001}`,
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS?.split(",") || [
    "http://localhost:3000",
    "http://localhost:8081",
    "exp://192.168.1.100:8081",
  ],

  // Optional: AWS S3 for direct uploads
  AWS_S3_BUCKET: process.env.AWS_S3_BUCKET,
  AWS_S3_REGION: process.env.AWS_S3_REGION,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_S3_PUBLIC_READ: /^true$/i.test(process.env.AWS_S3_PUBLIC_READ || "true"),
  UPLOAD_MAX_MB: Number(process.env.UPLOAD_MAX_MB || 10),
  AWS_CLOUDFRONT_DOMAIN: process.env.AWS_CLOUDFRONT_DOMAIN,
  // S3 prefixes
  AWS_S3_VERIFICATION_PREFIX: process.env.AWS_S3_VERIFICATION_PREFIX || 'verification/',

  // Optional: Google Vision API (fallback for OCR/classification)
  // Removed: GOOGLE_VISION_API_KEY (ocr/classification no longer used)

  // Geospatial tuning
  // Resolution used by application-side geo cell calculations (must match DB trigger default unless you update triggers)
  GEO_CELL_RES: Math.max(1, Math.min(100, Number(process.env.GEO_CELL_RES || 10))),

  // Removed: verification scoring/duplicate detection envs

  // Email / SMTP (optional)
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: Number(process.env.SMTP_PORT || 587),
  SMTP_SECURE: /^true$/i.test(process.env.SMTP_SECURE || 'false'),
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  EMAIL_FROM: process.env.EMAIL_FROM || 'no-reply@smartagro.local',
  ADMIN_EMAILS: (process.env.ADMIN_EMAILS || '').split(',').map(s=>s.trim()).filter(Boolean),
  DIGEST_CRON: process.env.DIGEST_CRON || '0 8 * * *', // 8am daily
  // Removed: VERIF_HIGH_RISK_SCORE

  // Moderation
  STRIKES_SUSPEND_THRESHOLD: Number(process.env.STRIKES_SUSPEND_THRESHOLD || 3),
}

// Validation function to check required environment variables
export function validateEnv() {
  const required = ["DATABASE_URL", "CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY", "CLERK_WEBHOOK_SECRET"]

  const missing = required.filter((key) => !ENV[key])

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`)
  }
}
