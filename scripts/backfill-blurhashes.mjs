#!/usr/bin/env node
import 'dotenv/config'
import fetch from 'node-fetch'

const API = process.env.API_URL || `http://localhost:${process.env.PORT || 3000}`
const LIMIT = Number(process.env.BLURHASH_BACKFILL_BATCH || 20)

async function run() {
  const auth = process.env.BACKFILL_AUTH_HEADER // optional: e.g. 'Bearer xyz'
  let totalUsers = 0
  let totalProducts = 0
  for (let i = 0; i < 200; i++) { // hard cap 200 iterations safety
    const res = await fetch(`${API}/api/utils/blurhash/backfill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify({ limit: LIMIT })
    })
    if (!res.ok) {
      console.error('Backfill request failed', res.status)
      process.exit(1)
    }
    const data = await res.json()
    if (!data.updatedUsers && !data.updatedProducts) {
      console.log('No more items to backfill. Done.')
      break
    }
    totalUsers += data.updatedUsers
    totalProducts += data.updatedProducts
    console.log(`Batch ${i+1}: users +${data.updatedUsers}, products +${data.updatedProducts}`)
    await new Promise(r => setTimeout(r, 500))
  }
  console.log(`Backfill complete. Users updated: ${totalUsers}, Products updated: ${totalProducts}`)
}

run().catch(e => { console.error(e); process.exit(1) })
