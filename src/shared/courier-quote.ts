import {
  quoteSignature as signature,
  signedCourierClaim,
  SHIPROCKET_QUOTE_TTL_MS,
} from "./quote-integrity"
import { shiprocketCartFingerprint } from "./cart-shipping"
import {
  CourierQuoteError,
  type CourierQuote,
  type CourierPolicy,
} from "../providers/shiprocket/utils/courier-policy"
import type { ShiprocketCalculateRateRequest } from "../providers/shiprocket/client/types"
export { SHIPROCKET_QUOTE_TTL_MS } from "./quote-integrity"
function cartFingerprint(context: Record<string, any>): string | undefined {
  return (
    context.shiprocket_quote_cart_fingerprint ??
    shiprocketCartFingerprint(context)
  )
}
export function signCourierQuote(
  quote: CourierQuote,
  params: ShiprocketCalculateRateRequest,
  context: Record<string, any>
): CourierQuote {
  const cart = cartFingerprint(context)
  if (!cart)
    throw new CourierQuoteError(
      "Cart fingerprint is required for a Shiprocket quote"
    )
  if (!context.from_location?.id)
    throw new CourierQuoteError(
      "Warehouse identifier is required for a Shiprocket quote"
    )
  if (!context.shiprocket_quote_option_id)
    throw new CourierQuoteError(
      "Shipping option quote scope is missing; synchronize Shiprocket shipping option configuration"
    )
  const { quote_token: _token, expires_at: _expiry, ...unsigned } = quote
  const snapshot = {
    ...unsigned,
    origin_location_id: context.from_location.id,
    origin_location_name:
      typeof context.from_location.name === "string"
        ? context.from_location.name
        : null,
  }
  const expires = Date.now() + SHIPROCKET_QUOTE_TTL_MS
  const body = Buffer.from(
    JSON.stringify({
      version: 1,
      quote: snapshot,
      option: context.shiprocket_quote_option_id,
      account: context.shiprocket_quote_account_scope,
      cart,
      origin: context.from_location.id,
      params,
      courier_company_id: quote.courier_company_id,
      amount: quote.amount,
      service: quote.service,
      policy: quote.policy,
      expires,
    })
  ).toString("base64url")
  return {
    ...snapshot,
    quote_token: body + "." + signature(body),
    expires_at: new Date(expires).toISOString(),
  }
}
export function verifyCourierQuote(
  value: unknown,
  context: Record<string, any>,
  policy: CourierPolicy
): ShiprocketCalculateRateRequest {
  const quote = value as any
  const fail = () => {
    throw new CourierQuoteError(
      "Shiprocket quote expired or changed; refresh delivery options and select again"
    )
  }
  const claim = signedCourierClaim(quote)
  if (!claim) return fail()
  if (
    claim.version !== 1 ||
    claim.option !== context.shiprocket_quote_option_id ||
    !context.shiprocket_quote_account_scope ||
    claim.account !== context.shiprocket_quote_account_scope ||
    !context.shiprocket_quote_option_id ||
    !Number.isFinite(claim.expires) ||
    claim.expires < Date.now() ||
    claim.expires > Date.now() + SHIPROCKET_QUOTE_TTL_MS ||
    claim.cart !== cartFingerprint(context) ||
    claim.origin !== context.from_location?.id ||
    claim.params?.pickup_postcode !==
      String(context.from_location?.address?.postal_code) ||
    claim.params?.delivery_postcode !==
      String(context.shipping_address?.postal_code) ||
    claim.params?.cod !== 0 ||
    claim.courier_company_id !== quote.courier_company_id ||
    claim.amount !== quote.amount ||
    claim.service !== quote.service ||
    JSON.stringify(claim.policy) !== JSON.stringify(policy)
  )
    return fail()
  return claim.params
}

export function readCourierQuote(
  value: unknown,
  context: Record<string, any>,
  policy: CourierPolicy
): { params: ShiprocketCalculateRateRequest; quote: CourierQuote } {
  const params = verifyCourierQuote(value, context, policy)
  const token = (value as CourierQuote).quote_token!
  const claim = JSON.parse(
    Buffer.from(token.split(".")[0], "base64url").toString()
  )
  const quote = claim.quote
  if (
    !quote ||
    quote.courier_company_id !== claim.courier_company_id ||
    quote.amount !== claim.amount ||
    quote.service !== claim.service
  )
    throw new CourierQuoteError(
      "Shiprocket quote data is invalid; refresh delivery options"
    )
  return {
    params,
    quote: {
      ...quote,
      quote_token: token,
      expires_at: new Date(claim.expires).toISOString(),
    },
  }
}
