import { ENV } from '../config/env.js'
let sharpMod = null
let blurhashMod = null

async function ensureDeps() {
  if (!sharpMod || !blurhashMod) {
    try {
      sharpMod = (await import('sharp')).default
      blurhashMod = await import('blurhash')
    } catch (e) {
      throw new Error('deps_unavailable')
    }
  }
  return { sharp: sharpMod, blurhash: blurhashMod }
}

export async function computeBlurhashFromBuffer(buffer, { targetWidth = 64, componentsX = 4, componentsY = 4 } = {}) {
  const { sharp, blurhash } = await ensureDeps()
  const img = sharp(buffer).rotate()
  const meta = await img.metadata()
  const w = meta.width || 0
  const h = meta.height || 0
  if (!w || !h) throw new Error('invalid_dimensions')
  const resizeW = Math.min(targetWidth, w)
  const resizeH = Math.round((resizeW / w) * h)
  const raw = await img.resize(resizeW, resizeH, { fit: 'inside' }).raw().ensureAlpha().toBuffer({ resolveWithObject: true })
  const { data, info } = raw
  const hash = blurhash.encode(new Uint8ClampedArray(data), info.width, info.height, componentsX, componentsY)
  return { hash, width: info.width, height: info.height, componentsX, componentsY }
}

export async function computeBlurhashFromUrl(url, opts) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  if (controller?.signal?.throwIfAborted) {
    setTimeout(() => controller.abort(), 8000).unref?.()
  }
  const resp = await fetch(url, { signal: controller?.signal })
  if (!resp.ok) throw new Error('fetch_failed')
  const arr = await resp.arrayBuffer()
  const buf = Buffer.from(arr)
  return computeBlurhashFromBuffer(buf, opts)
}

export function depsAvailable() {
  return !!(sharpMod && blurhashMod)
}
