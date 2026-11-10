import { createHmac, timingSafeEqual } from "node:crypto"
import { CourierQuoteError } from "../providers/shiprocket/utils/courier-policy"
export const SHIPROCKET_QUOTE_TTL_MS = 5 * 60 * 1000
export function quoteSignature(body: string): string {
  const key = process.env.JWT_SECRET
  if (!key || key.length < 32)
    throw new CourierQuoteError(
      "A configured JWT_SECRET of at least 32 characters is required to sign Shiprocket checkout quotes"
    )
  return createHmac("sha256", key).update(body).digest("base64url")
}
export function signedCourierClaim(value: unknown): any | undefined {
  try {
    const quote = value as any
    if (
      !quote ||
      typeof quote.quote_token !== "string" ||
      quote.quote_token.length > 12000
    )
      return undefined
    const parts = quote.quote_token.split(".")
    if (parts.length !== 2) return undefined
    const actual = Buffer.from(parts[1]),
      expected = Buffer.from(quoteSignature(parts[0]))
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return undefined
    const claim = JSON.parse(Buffer.from(parts[0], "base64url").toString())
    if (
      claim.version !== 1 ||
      !claim.quote ||
      !claim.account ||
      !claim.option ||
      !claim.origin ||
      !Number.isFinite(claim.expires) ||
      claim.expires <= Date.now() ||
      claim.expires > Date.now() + SHIPROCKET_QUOTE_TTL_MS ||
      claim.courier_company_id !== quote.courier_company_id ||
      claim.amount !== quote.amount ||
      claim.service !== quote.service ||
      claim.quote.courier_company_id !== claim.courier_company_id ||
      claim.quote.amount !== claim.amount ||
      claim.quote.service !== claim.service
    )
      return undefined
    return claim
  } catch {
    return undefined
  }
}
