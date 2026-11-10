import type { ExistingOrderBinding } from "./existing-order"
import { financialSnapshot, type FulfillmentFinancials } from "./order-money"
import { packedParcelForItems, type PackedParcel } from "./packed-parcel"
import {
  MedusaError,
  ContainerRegistrationKeys,
} from "@medusajs/framework/utils"
import { createHmac, timingSafeEqual } from "node:crypto"
import {
  pickupScope,
  requirePickupSnapshot,
  resolveMetadataPickup,
  pickupRows,
} from "./pickup-mapping"
import { getShiprocketManager } from "../providers/shiprocket/client/manager"
import { shiprocketApiUrl } from "../providers/shiprocket/client/config"
import {
  shiprocketItemMeasurements,
  type ShippingMeasurements,
} from "../providers/shiprocket/utils/quote"
import type { PickupSnapshot } from "./pickup-mapping"

const invalid = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message)
}
function signature(body: string) {
  const secret = process.env.JWT_SECRET
  if (!secret || secret.length < 32)
    return invalid("Shiprocket fulfillment signing is not configured")
  return createHmac("sha256", secret)
    .update("shiprocket:fulfillment-pickup:v1:" + body)
    .digest("base64url")
}
export async function prepareFulfillmentPickup(
  container: any,
  orderId: string,
  input: {
    shipping_option_id?: string
    location_id?: string
    additional_data?: Record<string, unknown>
    items?: { id: string; quantity: number }[]
  },
  lookup?: (id: string) => Promise<any>,
  resume?: ExistingOrderBinding
) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: orders } = await query.graph({
    entity: "order",
    filters: { id: orderId },
    fields: [
      "id",
      "shipping_methods.shipping_option_id",
      "shipping_methods.data",
      // The native order service computes nested method totals only when an order total is selected.
      "shipping_total",
      "shipping_methods.total",
      "shipping_methods.tax_total",
      "shipping_methods.discount_total",
      "currency_code",
      "summary.refunded_total",
      "fulfillments.id",
      "fulfillments.shipping_option_id",
      "fulfillments.data",
      "metadata",
      "billing_address.*",
      "items.id",
      "items.quantity",
      "items.requires_shipping",
      "items.original_total",
      "items.total",
      "items.tax_total",
      "items.original_tax_total",
      "items.tax_lines.rate",
      "items.detail.fulfilled_quantity",
      "items.variant.product.shipping_profile.id",
      "items.variant.weight",
      "items.variant.length",
      "items.variant.width",
      "items.variant.height",
      "items.variant.product.weight",
      "items.variant.product.length",
      "items.variant.product.width",
      "items.variant.product.height",
    ],
  })
  const order = orders[0]
  const optionId =
    input.shipping_option_id ?? order?.shipping_methods?.[0]?.shipping_option_id
  if (!optionId) return undefined
  const { data: options } = await query.graph({
    entity: "shipping_option",
    filters: {
      id: [
        ...new Set(
          [
            optionId,
            ...(order?.shipping_methods || []).map(
              (method: any) => method.shipping_option_id
            ),
          ].filter(Boolean)
        ),
      ],
    },
    fields: [
      "id",
      "provider_id",
      "shipping_profile_id",
      "service_zone.fulfillment_set.location.id",
    ],
  })
  const option = options.find((candidate: any) => candidate.id === optionId)
  if (!option?.provider_id?.endsWith("_shiprocket")) return undefined
  if (
    option.shipping_profile_id &&
    options.filter(
      (candidate: any) =>
        candidate.shipping_profile_id === option.shipping_profile_id &&
        order.shipping_methods?.some(
          (method: any) => method.shipping_option_id === candidate.id
        )
    ).length > 1
  )
    return invalid(
      "This order has multiple delivery methods for the same shipping profile without a verified per-method item allocation. Review the shipping allocation before fulfilling."
    )
  const method = order?.shipping_methods?.find(
    (value: any) => value.shipping_option_id === optionId
  )
  const quote = method?.data?.shiprocket_quote
  const locationId =
    input.location_id ?? option.service_zone?.fulfillment_set?.location?.id
  if (!locationId || quote?.origin_location_id !== locationId)
    return invalid(
      "Shiprocket fulfillment warehouse must match the selected delivery quote"
    )
  const { data: locations } = await query.graph({
    entity: "stock_location",
    filters: { id: locationId },
    fields: ["id", "name", "metadata", "address.*", "fulfillment_providers.id"],
  })
  const location = locations[0]
  if (
    !location?.fulfillment_providers?.some(
      (value: any) => value.id === option.provider_id
    )
  )
    return invalid("Shiprocket is not attached to the fulfillment warehouse")
  if (
    !process.env.SHIPROCKET_EMAIL?.trim() ||
    !process.env.SHIPROCKET_PASSWORD?.trim()
  )
    return invalid(
      "Shiprocket API credentials are missing from the running backend. Reload its configuration before retrying."
    )
  const scope = pickupScope(
    shiprocketApiUrl(),
    process.env.SHIPROCKET_EMAIL || ""
  )
  let pickup: PickupSnapshot
  try {
    pickup = await resolveMetadataPickup(
      locationId,
      location.metadata,
      scope,
      lookup ||
        (async (id) => {
          const response = await (
            await getShiprocketManager(container.resolve("logger")).getAxios()
          ).get("/settings/company/pickup", { params: { id } })
          return pickupRows(response.data).find((row) => String(row.id) === id)
        })
    )
  } catch (error: any) {
    const code = error?.message
    if (
      code === "PICKUP_METADATA_ID_REQUIRED" ||
      code === "INVALID_PICKUP_METADATA_ID"
    )
      return invalid(
        "Select an existing pickup in the Shiprocket pickup widget on this Medusa location; it saves metadata.shiprocket_pickup_id"
      )
    if (code === "PICKUP_METADATA_ACCOUNT_CHANGED")
      return invalid(
        "The linked pickup belongs to another Shiprocket account or mode; select a pickup from the current connection"
      )
    return invalid(
      "The pickup ID linked in this location's metadata could not be verified in Shiprocket; review the saved ID and API connection"
    )
  }
  const override = order.metadata?.shiprocket_fulfillment_couriers?.[optionId]
  let courier = quote
  if (override) {
    if (
      override.scope !== scope ||
      override.location_id !== locationId ||
      override.service !== quote.service ||
      !["air", "surface"].includes(override.service) ||
      !Number.isSafeInteger(override.courier_company_id) ||
      override.courier_company_id <= 0
    )
      return invalid(
        "The merchant courier selection does not match this delivery. Select an available courier again."
      )
    courier = {
      ...quote,
      courier_company_id: override.courier_company_id,
      courier_name: override.courier_name,
      amount: override.amount,
    }
  }
  const body = Buffer.from(
    JSON.stringify({
      order: orderId,
      option: optionId,
      pickup,
      courier,
      attempt_id: input.additional_data?.shiprocket_attempt_id,
      parcel: input.items?.length
        ? packedParcelForItems(order.metadata, optionId, input.items)
        : undefined,
      item_measurements: shiprocketItemMeasurements(order.items || []),
      resume,
      billing_address: order.billing_address,
      financials: financialSnapshot(
        order,
        method,
        input.items || [],
        option.shipping_profile_id
      ),
      shipping_charge: {
        currency_code: order.currency_code,
        total: method.total,
        tax_total: method.tax_total,
        discount_total: method.discount_total,
        refunded_total: order.summary?.refunded_total ?? 0,
        previous_fulfillments: (order.fulfillments || [])
          .filter((f: any) => f.shipping_option_id === optionId)
          .map((f: any) => ({ id: f.id, data: f.data })),
      },
      quote: quote.quote_token,
      expires: Date.now() + 60000,
    })
  ).toString("base64url")
  return body + "." + signature(body)
}
export function readFulfillmentContext(
  token: unknown,
  orderId: unknown,
  optionId: unknown,
  locationId: unknown,
  scope: string,
  quote: any
): {
  pickup: PickupSnapshot
  courier?: Record<string, any>
  item_measurements: Record<string, ShippingMeasurements>
  shipping_charge?: Record<string, any>
  attempt_id?: string
  parcel?: PackedParcel
  financials?: FulfillmentFinancials
  resume?: ExistingOrderBinding
  billing_address?: Record<string, any>
} {
  try {
    if (typeof token !== "string" || token.length > 128000) throw new Error()
    const [body, mac, extra] = token.split(".")
    const expected = Buffer.from(signature(body)),
      actual = Buffer.from(mac || "")
    if (
      extra ||
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    )
      throw new Error()
    const claim = JSON.parse(Buffer.from(body, "base64url").toString())
    if (
      claim.order !== orderId ||
      claim.option !== optionId ||
      claim.quote !== quote?.quote_token ||
      !Number.isFinite(claim.expires) ||
      claim.expires < Date.now() ||
      claim.expires > Date.now() + 60000
    )
      throw new Error()
    return {
      pickup: requirePickupSnapshot(claim.pickup, locationId, scope),
      courier: claim.courier,
      shipping_charge: claim.shipping_charge,
      attempt_id: claim.attempt_id,
      parcel: claim.parcel,
      financials: claim.financials,
      resume: claim.resume,
      billing_address: claim.billing_address,
      item_measurements:
        claim.item_measurements &&
        typeof claim.item_measurements === "object" &&
        !Array.isArray(claim.item_measurements)
          ? claim.item_measurements
          : {},
    }
  } catch {
    return invalid(
      "Shiprocket fulfillment pickup preflight is missing or stale; review the linked pickup and retry fulfillment"
    )
  }
}

export function readFulfillmentPickup(
  ...args: Parameters<typeof readFulfillmentContext>
): PickupSnapshot {
  return readFulfillmentContext(...args).pickup
}

export { shiprocketApiUrl } from "../providers/shiprocket/client/config"
export { getLineItemDimensions } from "../providers/shiprocket/utils/dimensions"
export {
  shiprocketQuote,
  shiprocketParcelDimensions,
} from "../providers/shiprocket/utils/quote"
