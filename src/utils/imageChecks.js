import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'

// Haversine distance in meters
function haversineMeters(a, b) {
  const R = 6371000
  const toRad = (deg) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const sinDLat = Math.sin(dLat / 2)
  const sinDLon = Math.sin(dLon / 2)
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
  return R * c
}

export async function runPerImageChecksFromS3({ region, credentials, bucket, key, expectedCode }) {
  const { buffer } = await fetchImageBufferFromS3({ region, credentials, bucket, key })
  return analyzeImageBuffer(buffer, { expectedCode })
}

export function geolocationHeuristic(images, { maxMeters = 200 } = {}) {
  const pts = images
    .map((i) => ({ lat: Number(i.lat), lng: Number(i.lng) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
  if (pts.length < 2) {
    return { withinRadius: true, maxDistanceMeters: 0 }
  }
  let maxD = 0
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      maxD = Math.max(maxD, haversineMeters(pts[i], pts[j]))
    }
  }
  return { withinRadius: maxD <= maxMeters, maxDistanceMeters: Math.round(maxD) }
}

// Fetch image buffer from S3 once and include basic headers (used for lightweight metadata only)
export async function fetchImageBufferFromS3({ region, credentials, bucket, key }) {
  const s3 = new S3Client({ region, credentials })
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key })
  const res = await s3.send(cmd)
  const chunks = []
  await new Promise((resolve, reject) => {
    res.Body.on('data', (c) => chunks.push(Buffer.from(c)))
    res.Body.on('end', resolve)
    res.Body.on('error', reject)
  })
  const buffer = Buffer.concat(chunks)
  return {
    buffer,
    contentType: res.ContentType || null,
    contentLength: res.ContentLength ?? (buffer?.length || null),
    etag: res.ETag || null,
  }
}
// All other heavy analyses (OCR/EXIF/pHash/classification) have been removed.
