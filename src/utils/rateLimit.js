// Simple in-memory token bucket (per key) for burst control
const buckets = new Map()

export function takeToken(key, { capacity = 20, refillRatePerSec = 1 } = {}) {
  const now = Date.now()
  let b = buckets.get(key)
  if (!b) { b = { tokens: capacity, last: now }; buckets.set(key, b) }
  // Refill
  const elapsed = (now - b.last) / 1000
  const refill = elapsed * refillRatePerSec
  if (refill > 0) {
    b.tokens = Math.min(capacity, b.tokens + refill)
    b.last = now
  }
  if (b.tokens >= 1) {
    b.tokens -= 1
    return true
  }
  return false
}
