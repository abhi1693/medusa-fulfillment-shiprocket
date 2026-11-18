import { createHash } from "node:crypto"
import {
  shiprocketCartFingerprint,
  SHIPROCKET_CART_FINGERPRINT,
} from "./cart-shipping"
export const PICKUP_ID_METADATA_KEY = "shiprocket_pickup_id"
export const PICKUP_SCOPE_METADATA_KEY = "shiprocket_pickup_scope"
export type PickupSnapshot = {
  stock_location_id: string
  nickname: string
  revision: string
  scope: string
  external_id: string
  postcode: string
}
export function pickupScope(apiUrl: string, identity: string) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        apiUrl.replace(/\/+$/, ""),
        identity.trim().toLowerCase(),
      ])
    )
    .digest("hex")
}
export function metadataPickupId(
  metadata: Record<string, unknown> | null | undefined,
  scope?: string
): string {
  const value = metadata?.[PICKUP_ID_METADATA_KEY]
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new Error("INVALID_PICKUP_METADATA_ID")
  const id = String(value ?? "").trim()
  if (!/^[1-9]\d*$/.test(id)) throw new Error("PICKUP_METADATA_ID_REQUIRED")
  const boundScope = metadata?.[PICKUP_SCOPE_METADATA_KEY]
  if (boundScope && scope && boundScope !== scope)
    throw new Error("PICKUP_METADATA_ACCOUNT_CHANGED")
  return id
}
export function pickupRows(body: any): any[] {
  const rows = Array.isArray(body)
    ? body
    : Array.isArray(body?.data)
      ? body.data
      : body?.data?.shipping_address
  if (Array.isArray(rows)) return rows
  if (body?.data?.id) return [body.data]
  if (body?.id) return [body]
  throw new Error("INVALID_PICKUP_LIST")
}
export async function resolveMetadataPickup(
  locationId: string,
  metadata: Record<string, unknown> | null | undefined,
  scope: string,
  lookup: (id: string) => Promise<any>
): Promise<PickupSnapshot> {
  const id = metadataPickupId(metadata, scope),
    row = await lookup(id)
  if (!row || String(row.id) !== id)
    throw new Error("PICKUP_METADATA_ID_NOT_FOUND")
  const nickname = row.pickup_location || row.pickup_code,
    postcode = String(row.pin_code ?? "").trim()
  if (!nickname || !/^\d{6}$/.test(postcode))
    throw new Error("PICKUP_REMOTE_RECORD_INCOMPLETE")
  return {
    stock_location_id: locationId,
    external_id: id,
    nickname,
    postcode,
    scope,
    revision: createHash("sha256")
      .update(JSON.stringify([locationId, scope, id]))
      .digest("hex"),
  }
}
export function requirePickupSnapshot(
  value: any,
  stockLocationId: unknown,
  scope?: string
): PickupSnapshot {
  if (
    !value ||
    (scope && value.scope !== scope) ||
    value.stock_location_id !== stockLocationId ||
    !value.nickname ||
    !value.revision ||
    !value.scope ||
    !value.external_id ||
    !value.postcode
  )
    throw new Error(
      "Shiprocket pickup is not linked to the selected stock location"
    )
  return value as PickupSnapshot
}
export function shiprocketCheckoutData(
  _optionData: Record<string, unknown>,
  data: Record<string, unknown>,
  context: Record<string, any> = {}
): Record<string, unknown> {
  const {
    shiprocket_pickup: _untrusted,
    shiprocket_quote: _quote,
    [SHIPROCKET_CART_FINGERPRINT]: _fingerprint,
    ...rest
  } = data
  const fingerprint = shiprocketCartFingerprint(context)
  if (fingerprint) rest[SHIPROCKET_CART_FINGERPRINT] = fingerprint
  return rest
}
