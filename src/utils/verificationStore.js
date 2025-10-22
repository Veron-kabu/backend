// Deprecated: in-memory store used during MVP. Persisted flows now use DB tables.

export const verificationStore = {
  // codes/submissions kept for backward compatibility but unused in current routes
  codes: new Map(),
  submissions: new Map(),
  userStatus: new Map(),
}

export function getUserVerificationStatus(userId) {
  return verificationStore.userStatus.get(userId) || 'unverified'
}

export function setUserVerificationStatus(userId, status) {
  verificationStore.userStatus.set(userId, status)
}
