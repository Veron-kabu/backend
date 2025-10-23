import { Router } from 'express'
import { ensureAuth } from '../middleware/auth.js'
import { ENV } from '../config/env.js'
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { takeToken } from '../utils/rateLimit.js'

const router = Router()

// Simple storage health / debug endpoint to introspect active storage mode without exposing secrets.
// Returns whether uploads are configured, if bucket objects are public, and which base domain will
// be used for newly uploaded media (S3 vs CloudFront). Useful for mobile diagnostics and CI smoke tests.
router.get('/uploads/storage-health', async (req,res) => {
  try {
    const { AWS_S3_BUCKET, AWS_S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_PUBLIC_READ, AWS_CLOUDFRONT_DOMAIN } = ENV
    const configured = !!(AWS_S3_BUCKET && AWS_S3_REGION && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY)
    const cfDomainValid = AWS_CLOUDFRONT_DOMAIN && !/your-cloudfront-domain/i.test(AWS_CLOUDFRONT_DOMAIN) ? AWS_CLOUDFRONT_DOMAIN : null
    const willUseCloudFront = configured && !!cfDomainValid && !!AWS_S3_PUBLIC_READ
    const basePublicOrigin = willUseCloudFront
      ? `https://${cfDomainValid}`
      : (configured ? `https://${AWS_S3_BUCKET}.s3.${AWS_S3_REGION}.amazonaws.com` : null)
    const mode = configured ? (willUseCloudFront ? 'cloudfront-public' : (AWS_S3_PUBLIC_READ ? 's3-public' : 's3-private')) : 'disabled'
    const signingStrategy = mode === 's3-private' ? 'always-sign' : 'on-demand'
    res.json({
      ok: true,
      configured,
      publicRead: !!AWS_S3_PUBLIC_READ,
      cloudFrontDomain: cfDomainValid,
      mode,
      signingStrategy,
      basePublicOrigin,
      notes: willUseCloudFront ? 'CloudFront active (public objects).' : (cfDomainValid && !AWS_S3_PUBLIC_READ ? 'CloudFront domain configured but bucket is private; falling back to S3 origin.' : null)
    })
  } catch (e) {
    console.error('storage-health error:', e)
    res.status(500).json({ ok: false, error: 'Failed to compute storage health' })
  }
})

// Auth-required object existence probe for debugging banner/profile failures.
// Query: /uploads/debug-head?url=<encoded S3 or CloudFront origin URL>
router.get('/uploads/debug-head', ensureAuth(), async (req,res) => {
  try {
    const { url } = req.query || {}
    if (!url) return res.status(400).json({ error: 'url required' })
    const { AWS_S3_BUCKET, AWS_S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } = ENV
    if (!AWS_S3_BUCKET || !AWS_S3_REGION) return res.status(501).json({ error: 'S3 not configured' })
    let key = null
    try {
      const u = new URL(url)
      // Accept either bucket host or cloudfront host: just strip leading '/'
      key = u.pathname.startsWith('/') ? u.pathname.slice(1) : u.pathname
    } catch { return res.status(400).json({ error: 'Invalid URL' }) }
    if (!key) return res.status(400).json({ error: 'Could not derive object key' })
    try {
      const s3 = new S3Client({ region: AWS_S3_REGION, credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } })
      // Use a lightweight signed GET URL to avoid separate HeadObject import; we won't fetch body.
      const cmd = new GetObjectCommand({ Bucket: AWS_S3_BUCKET, Key: key })
      const signed = await getSignedUrl(s3, cmd, { expiresIn: 60 })
      // Just attempt a HEAD fetch via native fetch (node since express environment). Fallback to GET if HEAD blocked.
      let status = null; let contentType = null; let contentLength = null
      try {
        const resp = await fetch(signed, { method: 'HEAD' })
        status = resp.status
        contentType = resp.headers.get('content-type')
        contentLength = resp.headers.get('content-length')
        if (status === 403) {
          // Retry GET in case HEAD is disallowed on presigned URL for this configuration
          const getResp = await fetch(signed, { method: 'GET' })
          status = getResp.status
          if (getResp.ok) {
            contentType = getResp.headers.get('content-type') || contentType
            contentLength = getResp.headers.get('content-length') || contentLength
          }
        }
      } catch (probeErr) {
        return res.json({ ok: false, key, probeError: probeErr.message, signedUrl: signed })
      }
      return res.json({ ok: status && status < 400, status, key, contentType, contentLength, signedUrl: signed })
    } catch (inner) {
      return res.json({ ok: false, key, error: inner.message })
    }
  } catch (e) {
    console.error('debug-head error:', e)
    res.status(500).json({ error: 'debug-head failed' })
  }
})

// Reliable existence check via S3 HeadObject (no body fetch)
router.get('/uploads/exists', ensureAuth(), async (req,res) => {
  try {
    const { key } = req.query || {}
    if (!key) return res.status(400).json({ ok: false, error: 'key required' })
    const { AWS_S3_BUCKET, AWS_S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } = ENV
    if (!AWS_S3_BUCKET || !AWS_S3_REGION) return res.status(501).json({ ok: false, error: 'S3 not configured' })
    const s3 = new S3Client({ region: AWS_S3_REGION, credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } })
    await s3.send(new HeadObjectCommand({ Bucket: AWS_S3_BUCKET, Key: String(key) }))
    return res.json({ ok: true })
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404) return res.json({ ok: false, error: 'not found' })
    return res.status(500).json({ ok: false, error: 'head failed' })
  }
})

// Client-reported incident logger for auditing upload anomalies (e.g., 400 with stored object)
router.post('/uploads/log-incident', ensureAuth(), async (req, res) => {
  try {
    const { key, status, message, originUrl, extra } = req.body || {}
    const userId = req.auth?.userId || 'unknown'
    console.warn('[upload:incident]', { userId, key, status, message, originUrl, extra })
    return res.json({ ok: true })
  } catch (e) {
    console.error('log-incident error:', e)
    return res.status(500).json({ ok: false })
  }
})

router.get('/uploads/avatar-signed-url', ensureAuth(), async (req,res) => {
  try {
    const { key } = req.query || {}
    if (!key || typeof key !== 'string') return res.status(400).json({ error: 'key is required' })
    const { AWS_S3_BUCKET, AWS_S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } = ENV
    const s3 = new S3Client({ region: AWS_S3_REGION, credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } })
    const cmd = new GetObjectCommand({ Bucket: AWS_S3_BUCKET, Key: key })
    const url = await getSignedUrl(s3, cmd, { expiresIn: 60 * 5 })
    res.json({ url })
  } catch (e) { console.error('signed-url error:', e); res.status(500).json({ error: 'Failed to get signed url' }) }
})

// Generic resolver (historically named resolve-avatar-url); works for any image (avatar/banner)
router.get('/uploads/resolve-avatar-url', ensureAuth(), async (req,res) => {
  try {
    const { url, force } = req.query || {}
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required' })
    const { AWS_S3_BUCKET, AWS_S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_PUBLIC_READ, AWS_CLOUDFRONT_DOMAIN } = ENV
    const isS3Like = (() => { try { const u = new URL(url); const host = u.host; if (AWS_CLOUDFRONT_DOMAIN && host === AWS_CLOUDFRONT_DOMAIN) return true; const s3Host = `${AWS_S3_BUCKET}.s3.${AWS_S3_REGION}.amazonaws.com`; return !!AWS_S3_BUCKET && !!AWS_S3_REGION && host === s3Host } catch { return false } })()
    const forceSign = force === '1' || force === 'true'
    if (!isS3Like) return res.json({ url, ttlSeconds: null, forcedSigned: false })
    if (AWS_S3_PUBLIC_READ && !forceSign) {
      // Optimistic assumption that public-read is correctly configured; client can retry with force=1 on 403.
      return res.json({ url, ttlSeconds: null, forcedSigned: false })
    }
    const u = new URL(url)
    let key = u.pathname.startsWith('/') ? u.pathname.slice(1) : u.pathname
    const s3 = new S3Client({ region: AWS_S3_REGION, credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } })
    const cmd = new GetObjectCommand({ Bucket: AWS_S3_BUCKET, Key: key })
    const expiresIn = 60 * 5
    const signed = await getSignedUrl(s3, cmd, { expiresIn })
    return res.json({ url: signed, ttlSeconds: expiresIn, forcedSigned: !!forceSign || !AWS_S3_PUBLIC_READ })
  } catch (e) { console.error('resolve-avatar-url error:', e); res.status(500).json({ error: 'Failed to resolve avatar url' }) }
})

// Batch resolver: resolve many media URLs in one request. Accepts body { urls: string[], force?: boolean }
router.post('/uploads/resolve-urls', ensureAuth(), async (req, res) => {
  try {
    const urls = Array.isArray(req.body?.urls) ? req.body.urls.filter(u => typeof u === 'string' && u.trim().length) : []
    const force = req.body?.force === true || req.body?.force === '1' || req.body?.force === 'true'
    if (urls.length === 0) return res.status(400).json({ error: 'urls (array) required' })
    const { AWS_S3_BUCKET, AWS_S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_PUBLIC_READ, AWS_CLOUDFRONT_DOMAIN } = ENV

    const s3 = (AWS_S3_BUCKET && AWS_S3_REGION && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY)
      ? new S3Client({ region: AWS_S3_REGION, credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } })
      : null

    const results = await Promise.all(urls.map(async (url) => {
      try {
        const isS3Like = (() => {
          try {
            const u = new URL(url)
            const host = u.host
            const cfValid = AWS_CLOUDFRONT_DOMAIN && !/your-cloudfront-domain/i.test(AWS_CLOUDFRONT_DOMAIN) ? AWS_CLOUDFRONT_DOMAIN : null
            if (cfValid && host === cfValid) return true
            const s3Host = (AWS_S3_BUCKET && AWS_S3_REGION) ? `${AWS_S3_BUCKET}.s3.${AWS_S3_REGION}.amazonaws.com` : null
            return !!s3Host && host === s3Host
          } catch {
            return false
          }
        })()
        const forceSign = !!force
        if (!isS3Like || !s3) return { in: url, out: url, signed: false }
        if (AWS_S3_PUBLIC_READ && !forceSign) return { in: url, out: url, signed: false }
        const u = new URL(url)
        const key = u.pathname.startsWith('/') ? u.pathname.slice(1) : u.pathname
        const cmd = new GetObjectCommand({ Bucket: AWS_S3_BUCKET, Key: key })
        const expiresIn = 60 * 5
        const signed = await getSignedUrl(s3, cmd, { expiresIn })
        return { in: url, out: signed, signed: true, ttlSeconds: expiresIn }
      } catch (e) {
        return { in: url, out: url, signed: false, error: e?.message || 'resolve failed' }
      }
    }))

    // Preserve order and return simple array of resolved URLs
    const resolved = results.map(r => r.out)
    return res.json({ items: resolved })
  } catch (e) {
    console.error('batch resolve error:', e)
    return res.status(500).json({ error: 'Failed to resolve urls' })
  }
})

function presignFactory(kind) {
  return async (req,res) => {
    try {
      // Rate limit: generous but prevents abuse / accidental rapid multi-select. 30 uploads burst, 0.5 token/sec refill.
      const rlKey = `presign_${kind}_${req.auth.userId}`
      if (!takeToken(rlKey, { capacity: 30, refillRatePerSec: 0.5 })) {
        return res.status(429).json({ error: 'Too many upload requests. Slow down.' })
      }
      const { contentType = 'image/jpeg', contentLength } = req.body || {}
      const { AWS_S3_BUCKET, AWS_S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_PUBLIC_READ, UPLOAD_MAX_MB, AWS_CLOUDFRONT_DOMAIN } = ENV
      if (!AWS_S3_BUCKET || !AWS_S3_REGION || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) return res.status(501).json({ error: 'Uploads not configured' })
      const allowed = ['image/jpeg','image/png','image/webp']
      if (!allowed.includes(contentType)) return res.status(400).json({ error: 'Unsupported content type', allowed })
      if (contentLength && Number(contentLength) > UPLOAD_MAX_MB * 1024 * 1024) return res.status(413).json({ error: `File too large. Max ${UPLOAD_MAX_MB}MB` })
      const s3 = new S3Client({ region: AWS_S3_REGION, credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } })
      const key = `${kind}/${req.auth.userId}/${Date.now()}`
      const acl = AWS_S3_PUBLIC_READ ? 'public-read' : undefined
      const cmd = new PutObjectCommand({ Bucket: AWS_S3_BUCKET, Key: key, ContentType: contentType, ACL: acl })
      const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 60 * 5 })
      const cfDomain = (AWS_CLOUDFRONT_DOMAIN && !/your-cloudfront-domain/i.test(AWS_CLOUDFRONT_DOMAIN)) ? AWS_CLOUDFRONT_DOMAIN : null
      const useCloudFront = !!cfDomain && AWS_S3_PUBLIC_READ
      const originUrl = useCloudFront
        ? `https://${cfDomain}/${key}`
        : `https://${AWS_S3_BUCKET}.s3.${AWS_S3_REGION}.amazonaws.com/${key}`
      res.json({ uploadUrl, publicUrl: originUrl, contentType, acl: acl || 'private' })
    } catch (e) { console.error(`${kind} presign error:`, e); res.status(500).json({ error: `Failed to presign ${kind} upload` }) }
  }
}

router.post('/uploads/avatar-presign', ensureAuth(), presignFactory('avatars'))
// Product image presign (used by mobile when creating listings). Falls back to avatar-presign on client if absent.
router.post('/uploads/product-presign', ensureAuth(), presignFactory('products'))
// Banner image presign mirrors avatar flow; kept separate for cleaner S3 prefixes and permissions if needed.
router.post('/uploads/banner-presign', ensureAuth(), presignFactory('banners'))

export default router