import { shiprocketConnection } from "./connection"
import { paidPackedUnitPlan, selectPackedUnit } from "./packed-unit-plan"
import { shipmentLineKey } from "./cart-shipment-plan"
import { fulfillmentCourier } from "./fulfillment-courier"
import { orderShipmentAllocation } from "./order-shipment-allocation"
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
    package_id?: string
    additional_data?: Record<string, unknown>
    items?: { id: string; quantity: number }[]
  },
  lookup?: (id: string) => Promise<any>,
  resume?: ExistingOrderBinding,
  recoveryReference?: string
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
      "fulfillments.canceled_at",
      "fulfillments.items.line_item_id",
      "fulfillments.items.quantity",
      "metadata",
      "billing_address.*",
      "items.id",
      "items.variant_id",
      "items.unit_price",
      "items.is_tax_inclusive",
      "items.metadata",
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
  const allocatedLines = orderShipmentAllocation(
    order,
    optionId,
    input.items || []
  )
  if (
    !allocatedLines &&
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
  const connection = await shiprocketConnection(container)
  const scope = pickupScope(shiprocketApiUrl(connection.mode), connection.email)
  let pickup: PickupSnapshot
  try {
    pickup = await resolveMetadataPickup(
      locationId,
      location.metadata,
      scope,
      lookup ||
        (async (id) => {
          const response = await (
            await getShiprocketManager(
              container.resolve("logger"),
              connection
            ).getAxios()
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
        "Link this stock location to an existing pickup in Settings → Shiprocket → Pickup mappings."
      )
    if (code === "PICKUP_METADATA_ACCOUNT_CHANGED")
      return invalid(
        "The linked pickup belongs to another Shiprocket account or mode; select a pickup from the current connection"
      )
    return invalid(
      "The pickup ID linked in this location's metadata could not be verified in Shiprocket; review the saved ID and API connection"
    )
  }
  const plan = paidPackedUnitPlan(quote)
  const unit = plan
    ? selectPackedUnit(
        plan,
        allocatedLines || order.items || [],
        input.items || [],
        optionId,
        input.package_id
      )
    : undefined
  if (input.package_id !== undefined && !unit)
    return invalid("The selected shipping package is no longer available")
  const courier = fulfillmentCourier(
    order.metadata,
    {
      shipping_option_id: optionId,
      location_id: locationId,
      scope,
      package_id: unit?.id,
    },
    unit?.courier || quote
  )
  const merchantSelection = unit
    ? order.metadata?.shiprocket_package_couriers?.[unit.id]
    : order.metadata?.shiprocket_fulfillment_couriers?.[optionId]
  const body = Buffer.from(
    JSON.stringify({
      order: orderId,
      option: optionId,
      pickup,
      courier,
      // Only a validated instruction in merchant-owned order metadata can
      // authorize its reviewed price. Customer quote fields cannot set this.
      merchant_courier_selection:
        merchantSelection === undefined
          ? undefined
          : {
              courier_company_id: courier.courier_company_id,
              service: courier.service,
              amount: courier.amount,
            },
      attempt_id: input.additional_data?.shiprocket_attempt_id,
      parcel: unit
        ? { ...unit.measurements, items: input.items }
        : input.items?.length
          ? packedParcelForItems(order.metadata, optionId, input.items)
          : undefined,
      item_measurements: unit
        ? plan?.combined
          ? Object.fromEntries(
              (allocatedLines || order.items || [])
                .map((line: any) => [
                  line.id,
                  plan.units.find((u) => u.key === shipmentLineKey(line))
                    ?.measurements,
                ])
                .filter(([, measurements]: any) => measurements)
            )
          : { [input.items![0].id]: unit.measurements }
        : shiprocketItemMeasurements(order.items || []),
      package_id: unit?.id,
      resume,
      recovery_reference: recoveryReference,
      billing_address: order.billing_address,
      financials: financialSnapshot(
        allocatedLines ? { ...order, items: allocatedLines } : order,
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
  package_id?: string
  courier?: Record<string, any>
  merchant_courier_selection?: {
    courier_company_id: number
    service: string
    amount: number
  }
  item_measurements: Record<string, ShippingMeasurements>
  shipping_charge?: Record<string, any>
  attempt_id?: string
  parcel?: PackedParcel
  financials?: FulfillmentFinancials
  resume?: ExistingOrderBinding
  recovery_reference?: string
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
      merchant_courier_selection: claim.merchant_courier_selection,
      package_id: claim.package_id,
      shipping_charge: claim.shipping_charge,
      attempt_id: claim.attempt_id,
      parcel: claim.parcel,
      financials: claim.financials,
      resume: claim.resume,
      recovery_reference: claim.recovery_reference,
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
