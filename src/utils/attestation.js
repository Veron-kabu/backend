export async function validateAttestation(attestationToken) {
  if (!attestationToken) return { status: 'not_provided', reasons: ['no_token'] }
  // Stubbed adapter: in real implementation call Play Integrity / DeviceCheck
  // For now, perform simple shape checks only
  try {
    const len = typeof attestationToken === 'string' ? attestationToken.length : 0
    if (len > 20) {
      return { status: 'valid', reasons: ['stub_validation'] }
    }
    return { status: 'suspect', reasons: ['token_too_short'] }
  } catch (e) {
    return { status: 'suspect', reasons: ['exception'] }
  }
}
