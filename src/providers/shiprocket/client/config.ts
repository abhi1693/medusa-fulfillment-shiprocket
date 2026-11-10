const rawTimeout = Number(process.env.SHIPROCKET_API_TIMEOUT_MS ?? 15000)
export const SHIPROCKET_DEFAULT_TIMEOUT_MS = Number.isFinite(rawTimeout)
  ? Math.min(Math.max(Math.floor(rawTimeout), 1000), 60000)
  : 15000

export function isRetryableShiprocketStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status)
}

export function shiprocketApiUrl(
  mode = process.env.SHIPROCKET_MODE ?? "test"
): string {
  if (mode === "test") return "https://api-sandbox.shiprocket.in/v1/external"
  if (mode === "live") return "https://apiv2.shiprocket.in/v1/external"
  throw new Error("SHIPROCKET_MODE must be test or live")
}

export function shiprocketRetryDelay(error: any, failures = 1): number {
  const headers = error?.response?.headers
  const raw =
    headers?.get?.("retry-after") ??
    headers?.["retry-after"] ??
    headers?.["Retry-After"]
  if (raw !== undefined && raw !== null && String(raw).trim()) {
    const seconds = Number(raw)
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.max(1000, seconds * 1000)
    const date = Date.parse(String(raw))
    if (Number.isFinite(date) && date > Date.now()) return date - Date.now()
  }
  const status = error?.response?.status
  if ([400, 401, 403, 422, 498].includes(status)) return 60000
  return Math.min(60000, 1000 * 2 ** Math.min(Math.max(failures - 1, 0), 6))
}
