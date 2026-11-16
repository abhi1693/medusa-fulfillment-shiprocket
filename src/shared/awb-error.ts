export type AwbErrorDiagnostic = {
  message?: string
  action_required?: string
  status_code?: string | number
}

// Read only allowed error fields, never serialize a response/configuration.
export function awbErrorDiagnostic(
  body: any,
  sensitiveValues: unknown[] = []
): AwbErrorDiagnostic {
  const sanitize = (value: unknown, limit: number) => {
    if (typeof value !== "string") return ""
    let text = value
      .slice(0, 8192)
      .replace(/\u001b\[[0-9;]*m/g, "")
      .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
    for (const value of sensitiveValues) {
      if (typeof value !== "string" || value.trim().length < 2) continue
      const secret = value.trim().replace(/\s+/g, " ")
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      text = text.replace(
        new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu"),
        "[redacted]"
      )
    }
    text = text
      .replace(/https?:\/\/[^\s<>"']+/gi, "[url redacted]")
      .replace(/\bBearer\s+[^\s"',;}]+/gi, "Bearer [redacted]")
      .replace(
        /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g,
        "[token redacted]"
      )
      .replace(
        /\b((?:authorization|password|passwd|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret)["']?\s*[:=]\s*)["']?[^\s"',;}]+/gi,
        "$1[redacted]"
      )
      .replace(
        /(["'](?:billing_|shipping_|customer_)?(?:first_name|last_name|customer_name|full_name|address(?:_[12])?|phone|email)["']\s*:\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
        "$1[redacted]"
      )
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email redacted]")
      .replace(/\+?\d[\d ().-]{8,}\d/g, "[phone redacted]")
    return text.length > limit ? text.slice(0, limit - 1) + "…" : text
  }
  const values = [
    body?.response?.data?.awb_assign_error,
    body?.response?.data?.rmk,
    body?.response?.data,
    body?.message,
    body?.error,
    body?.response?.message,
    body?.response?.error,
    body?.response?.data?.message,
    body?.response?.data?.error,
  ]
  const messages = [
    ...new Set(values.map((value) => sanitize(value, 600)).filter(Boolean)),
  ]
  const message = messages.join("; ").slice(0, 1000)
  const action = sanitize(
    body?.response?.action_required ?? body?.action_required,
    300
  )
  const code = body?.status_code ?? body?.response?.status_code
  const status_code =
    typeof code === "number" && Number.isFinite(code)
      ? code
      : typeof code === "string" && /^\d{1,6}$/.test(code)
        ? code
        : undefined
  return {
    ...(message ? { message } : {}),
    ...(action ? { action_required: action } : {}),
    ...(status_code !== undefined ? { status_code } : {}),
  }
}

export function awbErrorSummary(diagnostic: AwbErrorDiagnostic): string {
  return [
    diagnostic.message,
    diagnostic.action_required
      ? `Action required: ${diagnostic.action_required}`
      : undefined,
    diagnostic.status_code !== undefined
      ? `Shiprocket code: ${diagnostic.status_code}`
      : undefined,
  ]
    .filter(Boolean)
    .join(". ")
}
