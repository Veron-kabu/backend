#!/usr/bin/env node
// Lightweight tests for scoring and duplicates utilities.
// Usage: node scripts/test-verification-checks.mjs

import assert from 'node:assert'
import { scoreSubmission } from '../src/utils/scoring.js'
import { hammingDistanceHex } from '../src/utils/duplicates.js'

function testScoring() {
  const imagesGood = [
    { checks: { ocr: { found: true }, exif: { ok: true }, classification: { likelyFarm: true } } },
    { checks: { ocr: { found: false }, exif: { ok: false }, classification: { likelyFarm: true } } },
    { checks: { ocr: { found: false }, exif: { ok: true }, classification: { likelyFarm: false } } },
  ]
  const { score, signals } = scoreSubmission({
    images: imagesGood,
    attestation: { status: 'valid' },
    duplicateFound: false,
    geoLikely: true,
  })
  // Expected: codeFound 4 + exifOk 2 + photoCount 2 + attestation 3 + geo 3 + class 2 = 16
  assert.equal(score, 16, 'Scoring should total 16 for strong submission')
  assert.equal(signals.codeFound, 1)
  assert.equal(signals.exifOk, 1)
  assert.equal(signals.photoCount, 1)
  assert.equal(signals.attestationValid, 1)
  assert.equal(signals.geoLikely, 1)
  assert.equal(signals.imageClassLikelyFarm, 1)

  const poor = [{ checks: { ocr: { found: false }, exif: { ok: false }, classification: { likelyFarm: false } } }]
  const s2 = scoreSubmission({ images: poor, attestation: { status: 'suspect' }, duplicateFound: true, geoLikely: false })
  // duplicate penalty -5; others 0
  assert.equal(s2.score, -5, 'Poor submission should have -5 from duplicate penalty')
}

function testHamming() {
  // distance should be 0 for same pHash
  assert.equal(hammingDistanceHex('ffffffffffffffff', 'ffffffffffffffff'), 0)
  // distance for completely different
  const d = hammingDistanceHex('0000000000000000', 'ffffffffffffffff')
  assert.equal(d, 64, 'Hamming distance for opposite should be 64 for 64-bit pHash')
}

function main() {
  testScoring()
  testHamming()
  console.log('All tests passed.')
}

main()
