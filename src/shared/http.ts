import type { MedusaResponse } from "@medusajs/framework/http"

export function ok(res: MedusaResponse, data: Record<string, unknown>, status = 200) {
  return res.status(status).json({ success: true, ...data })
}

export function fail(
  res: MedusaResponse,
  status: number,
  code: string,
  message: string,
  details?: unknown
) {
  return res.status(status).json({
    success: false,
    code,
    message,
    ...(details !== undefined ? { details } : {}),
  })
}

export function isValidAwb(value: unknown): value is string {
  if (typeof value !== "string") {
    return false
  }
  return /^[A-Za-z0-9-]{6,40}$/.test(value.trim())
}
