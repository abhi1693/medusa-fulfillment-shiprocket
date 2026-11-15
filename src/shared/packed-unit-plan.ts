import { orderShipmentAllocation } from "./order-shipment-allocation"
import { createHash } from "node:crypto"
import { shipmentLineKey } from "./cart-shipment-plan"
import { signedCourierClaim } from "./quote-integrity"
import {
  shiprocketItemMeasurements,
  shiprocketQuote,
  type ShippingMeasurements,
} from "../providers/shiprocket/utils/quote"
import type { CourierQuote } from "../providers/shiprocket/utils/courier-policy"
import { MedusaError } from "@medusajs/framework/utils"

function invalid(message: string): never {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message)
}

export type PackedUnit = {
  key: string
  variant_id: string
  quantity: number
  measurements: ShippingMeasurements
  courier: Pick<
    CourierQuote,
    "courier_company_id" | "courier_name" | "amount" | "service"
  >
}
export type PackedUnitPlan = { version: 1; units: PackedUnit[] }
export function packedUnitInputs(context: Record<string, any>) {
  const measurements = shiprocketItemMeasurements(context.items || [])
  const rows = new Map<
    string,
    {
      key: string
      variant_id: string
      quantity: number
      measurements: ShippingMeasurements
      params: ReturnType<typeof shiprocketQuote>
    }
  >()
  for (const item of context.items || []) {
    if (item.requires_shipping === false) continue
    const quantity = Number(item.quantity)
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000)
      invalid("Packed unit quantity must be between 1 and 1000")
    const m =
      context.shiprocket_item_measurements?.[item.id] || measurements[item.id]
    if (
      !m ||
      !Object.values(m).every(
        (v) => Number.isFinite(Number(v)) && Number(v) > 0
      )
    )
      invalid(
        "Complete the packed weight and dimensions for every product before shipping"
      )
    const key = shipmentLineKey(item)
    const previous = rows.get(key)
    if (previous && JSON.stringify(previous.measurements) !== JSON.stringify(m))
      invalid("Conflicting packed measurements for the same order line")
    rows.set(key, {
      key,
      variant_id: item.variant_id || item.variant?.id,
      quantity: quantity + (previous?.quantity || 0),
      measurements: m,
      params: shiprocketQuote({ ...context, shiprocket_parcel: m }),
    })
  }
  if (rows.size > 50)
    invalid("A shipping order supports up to 50 distinct packed products")
  if (!rows.size) invalid("At least one packed shipping unit is required")
  return [...rows.values()].sort((a, b) => a.key.localeCompare(b.key))
}
/** One quote request per distinct geometry; one charge per physical packed unit. */
export async function quotePackedUnits(
  context: Record<string, any>,
  quote: (params: any) => Promise<CourierQuote[]>
) {
  const inputs = packedUnitInputs(context)
  const requests = new Map<string, Promise<CourierQuote[]>>()
  const results = await Promise.all(
    inputs.map(async (input) => {
      const key = JSON.stringify(input.params)
      if (!requests.has(key)) requests.set(key, quote(input.params))
      return { input, quotes: await requests.get(key)! }
    })
  )
  const choices: CourierQuote[] = []
  for (const service of ["surface", "air"] as const) {
    const units: PackedUnit[] = []
    for (const { input, quotes } of results) {
      const courier = quotes.find((q) => q.service === service)
      if (!courier) break
      units.push({
        key: input.key,
        variant_id: input.variant_id,
        quantity: input.quantity,
        measurements: input.measurements,
        courier: {
          courier_company_id: courier.courier_company_id,
          courier_name: courier.courier_name,
          amount: courier.amount,
          service: courier.service,
        },
      })
    }
    if (units.length !== inputs.length) continue
    const first = results[0].quotes.find((q) => q.service === service)!
    choices.push({
      ...first,
      courier_name:
        new Set(units.map((u) => u.courier.courier_company_id)).size > 1
          ? "Multiple couriers"
          : first.courier_name,
      amount:
        units.reduce(
          (sum, u) => sum + Math.round(u.courier.amount * 100) * u.quantity,
          0
        ) / 100,
      parcel_plan: { version: 1, units },
      relaxed_preferences: [
        ...new Set(
          results.flatMap(
            (r) =>
              r.quotes.find((q) => q.service === service)!.relaxed_preferences
          )
        ),
      ],
    })
  }
  if (!choices.length)
    invalid(
      "No common delivery service is available for all packed products"
    )
  return { choices, params: inputs[0].params }
}
/** Signed paid plan, deliberately independent of later catalog edits. */
export function paidPackedUnitPlan(quote: any): PackedUnitPlan | undefined {
  const claim = signedCourierClaim(quote, true)
  const plan = claim?.quote?.parcel_plan
  if (!plan) {
    if (quote?.parcel_plan)
      invalid("The paid package plan could not be verified")
    return undefined
  }
  if (plan.version !== 1 || !Array.isArray(plan.units) || !plan.units.length)
    invalid("The paid package plan is invalid; review this order")
  return plan
}
export function selectPackedUnit(
  plan: PackedUnitPlan,
  orderItems: any[],
  selected: { id: string; quantity: number }[],
  optionId = ""
) {
  if (selected.length !== 1 || Number(selected[0].quantity) !== 1)
    invalid(
      "Dispatch one packed unit per fulfillment, or use Dispatch packages"
    )
  const line = orderItems.find((i) => i.id === selected[0].id)
  const key = line && shipmentLineKey(line)
  const unit = plan.units.find((u) => u.key === key)
  const same = orderItems
    .filter((i) => shipmentLineKey(i) === key)
    .sort((a, b) => a.id.localeCompare(b.id))
  const ordered = same.reduce((n, i) => n + Number(i.quantity), 0)
  const ordinal = same.reduce(
    (n, i) => n + Number(i.detail?.fulfilled_quantity || 0),
    0
  )
  if (!unit || ordered !== unit.quantity || ordinal >= unit.quantity)
    invalid("Order quantities no longer match the paid package plan")
  return {
    ...unit,
    id: createHash("sha256")
      .update(JSON.stringify([optionId, key, ordinal]))
      .digest("hex"),
    ordinal,
  }
}

export function remainingPackedUnits(order: any) {
  const jobs: {
    id: string
    title: string
    shipping_option_id: string
    location_id: string
    items: { id: string; quantity: number }[]
    measurements: ShippingMeasurements
    carrier_amount: number
    courier_name: string
    service: string | null
  }[] = []
  for (const method of order.shipping_methods || []) {
    const quote = method.data?.shiprocket_quote
    const plan = paidPackedUnitPlan(quote)
    if (!plan) continue
    const assigned =
      orderShipmentAllocation(order, method.shipping_option_id, []) ||
      order.items ||
      []
    for (const unit of plan.units) {
      const lines = assigned
        .filter((line: any) => shipmentLineKey(line) === unit.key)
        .sort((a: any, b: any) => a.id.localeCompare(b.id))
      if (
        lines.reduce((n: number, l: any) => n + Number(l.quantity), 0) !==
        unit.quantity
      )
        invalid("Order quantities no longer match the paid package plan")
      let ordinal = lines.reduce(
        (n: number, l: any) => n + Number(l.detail?.fulfilled_quantity || 0),
        0
      )
      for (const line of lines) {
        const remaining =
          Number(line.quantity) - Number(line.detail?.fulfilled_quantity || 0)
        for (let n = 0; n < remaining; n++, ordinal++)
          jobs.push({
            id: createHash("sha256")
              .update(
                JSON.stringify([method.shipping_option_id, unit.key, ordinal])
              )
              .digest("hex"),
            title: line.title || line.variant_sku || "Product",
            shipping_option_id: method.shipping_option_id,
            location_id: quote.origin_location_id,
            items: [{ id: line.id, quantity: 1 }],
            measurements: unit.measurements,
            carrier_amount: unit.courier.amount,
            courier_name: unit.courier.courier_name,
            service: unit.courier.service,
          })
      }
    }
  }
  return jobs
}
