// Request-local observation only. The merchant's durable lock remains held after uncertain remote writes.
const attempts = new Set<string>()
export function markFulfillmentRemoteAttempt(id: string | undefined) {
  if (id) attempts.add(id)
}
export function hasFulfillmentRemoteAttempt(id: string) {
  return attempts.has(id)
}
export function forgetFulfillmentRemoteAttempt(id: string) {
  attempts.delete(id)
}
