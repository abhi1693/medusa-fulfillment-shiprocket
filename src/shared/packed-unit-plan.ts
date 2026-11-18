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
import {
  fallbackMeasurements,
  shipmentPolicy,
  type ShipmentPolicy,
} from "./shipment-policy"

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
export type PackedUnitPlan = {
  version: 1
  units: PackedUnit[]
  policy?: ShipmentPolicy
  combined?: {
    measurements: ShippingMeasurements
    courier: PackedUnit["courier"]
  }
}
/** Keep all dimensions from one largest-volume item; never mix unrelated sides. */
export function combinedMeasurements(
  inputs: ReturnType<typeof packedUnitInputs>,
  policy: ShipmentPolicy
): ShippingMeasurements {
  const volume = (m: ShippingMeasurements) =>
    Number(m.length_mm) * Number(m.width_mm) * Number(m.height_mm)
  const largest = [...inputs].sort(
    (a, b) =>
      volume(b.measurements) - volume(a.measurements) ||
      a.key.localeCompare(b.key)
  )[0]
  const measurements = {
    weight_grams: inputs.reduce(
      (sum, row) => sum + Number(row.measurements.weight_grams) * row.quantity,
      0
    ),
    length_mm: Number(largest.measurements.length_mm),
    width_mm: Number(largest.measurements.width_mm),
    height_mm: Number(largest.measurements.height_mm),
  }
  if (policy.single_shipment_dimensions === "stacked") {
    measurements.length_mm = Math.max(
      ...inputs.map((r) => Number(r.measurements.length_mm))
    )
    measurements.width_mm = Math.max(
      ...inputs.map((r) => Number(r.measurements.width_mm))
    )
    measurements.height_mm = inputs.reduce(
      (sum, r) => sum + Number(r.measurements.height_mm) * r.quantity,
      0
    )
  }
  if (!Object.values(measurements).every((v) => Number.isFinite(v) && v > 0))
    invalid("Combined package measurements are invalid")
  return measurements
}
export function packedUnitInputs(context: Record<string, any>) {
  const policy = shipmentPolicy(context.shiprocket_shipment_policy)
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
    const m = fallbackMeasurements(
      context.shiprocket_item_measurements?.[item.id] || measurements[item.id],
      policy
    )
    if (
      !m ||
      !Object.values(m).every(
        (v) =>
          (typeof v === "number" || typeof v === "string") &&
          Number.isFinite(Number(v)) &&
          Number(v) > 0
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
  const policy = shipmentPolicy(context.shiprocket_shipment_policy)
  if (policy.multiple_items === "single_shipment") {
    const measurements = combinedMeasurements(inputs, policy)
    const params = shiprocketQuote({
      ...context,
      shiprocket_parcel: measurements,
    })
    const choices = (await quote(params)).map((courier) => ({
      ...courier,
      parcel_plan: {
        version: 1 as const,
        policy,
        units: inputs.map(({ key, variant_id, quantity, measurements }) => ({
          key,
          variant_id,
          quantity,
          measurements,
          courier,
        })),
        combined: { measurements, courier },
      },
    }))
    if (!choices.length)
      invalid("No delivery service is available for the combined package")
    return { choices, params }
  }
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
      parcel_plan: { version: 1, units, policy },
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
    invalid("No common delivery service is available for all packed products")
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
  if ((plan.policy?.multiple_items === "single_shipment") !== !!plan.combined)
    invalid("The paid combined package plan is invalid; review this order")
  return plan
}
export function selectPackedUnit(
  plan: PackedUnitPlan,
  orderItems: any[],
  selected: { id: string; quantity: number }[],
  optionId = "",
  packageId?: string
) {
  if (plan.combined) {
    const lines = combinedOrderLines(plan, orderItems)
    const id = combinedPackageId(optionId, plan)
    if (packageId !== undefined && packageId !== id)
      invalid("The selected shipping package is no longer available")
    const expected = lines
      .map((line: any) => [line.id, Number(line.quantity)])
      .sort()
    const actual = selected
      .map((line) => [line.id, Number(line.quantity)])
      .sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      invalid("Fulfill all items in the combined package together.")
    if (
      lines.some(
        (line: any) => Number(line.detail?.fulfilled_quantity || 0) > 0
      )
    )
      invalid(
        "The combined package has already been fulfilled or partially fulfilled; review this order"
      )
    return { ...plan.units[0], ...plan.combined, id, ordinal: 0 }
  }
  if (selected.length !== 1 || Number(selected[0].quantity) !== 1)
    invalid("Fulfill one packed unit at a time.")
  const line = orderItems.find((i) => i.id === selected[0].id)
  const key = line && shipmentLineKey(line)
  const unit = plan.units.find((u) => u.key === key)
  const same = orderItems
    .filter((i) => shipmentLineKey(i) === key)
    .sort((a, b) => a.id.localeCompare(b.id))
  const ordered = same.reduce((n, i) => n + Number(i.quantity), 0)
  let ordinal = same.reduce(
    (n, i) => n + Number(i.detail?.fulfilled_quantity || 0),
    0
  )
  if (!unit || ordered !== unit.quantity || ordinal >= unit.quantity)
    invalid("Order quantities no longer match the paid package plan")
  if (packageId !== undefined) {
    let cursor = ordinal
    let requested: number | undefined
    for (const candidate of same) {
      const remaining =
        Number(candidate.quantity) -
        Number(candidate.detail?.fulfilled_quantity || 0)
      if (candidate.id === line.id)
        for (let n = 0; n < remaining; n++)
          if (packedUnitId(optionId, key, cursor + n) === packageId)
            requested = cursor + n
      cursor += remaining
    }
    if (requested === undefined)
      invalid("The selected shipping package is no longer available")
    ordinal = requested
  }
  return {
    ...unit,
    id: packedUnitId(optionId, key, ordinal),
    ordinal,
  }
}

function packedUnitId(optionId: string, key: string, ordinal: number) {
  return createHash("sha256")
    .update(JSON.stringify([optionId, key, ordinal]))
    .digest("hex")
}

function combinedPackageId(optionId: string, plan: PackedUnitPlan) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        optionId,
        "single_shipment",
        plan.units.map((u) => [u.key, u.quantity]),
        plan.combined?.measurements,
      ])
    )
    .digest("hex")
}
function combinedOrderLines(plan: PackedUnitPlan, items: any[]) {
  const lines = items.filter((line) =>
    plan.units.some((unit) => shipmentLineKey(line) === unit.key)
  )
  for (const unit of plan.units)
    if (
      lines
        .filter((line) => shipmentLineKey(line) === unit.key)
        .reduce((n, line) => n + Number(line.quantity), 0) !== unit.quantity
    )
      invalid("Order quantities no longer match the paid package plan")
  return lines
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
    courier_company_id: number
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
    if (plan.combined) {
      const lines = combinedOrderLines(plan, assigned)
      if (
        lines.every(
          (line: any) =>
            Number(line.detail?.fulfilled_quantity || 0) ===
            Number(line.quantity)
        )
      )
        continue
      if (
        lines.some(
          (line: any) => Number(line.detail?.fulfilled_quantity || 0) > 0
        )
      )
        invalid(
          "The combined package was partially fulfilled; review this order"
        )
      jobs.push({
        id: combinedPackageId(method.shipping_option_id, plan),
        title: "Combined package",
        shipping_option_id: method.shipping_option_id,
        location_id: quote.origin_location_id,
        items: lines.map((line: any) => ({
          id: line.id,
          quantity: Number(line.quantity),
        })),
        measurements: plan.combined.measurements,
        carrier_amount: plan.combined.courier.amount,
        courier_company_id: plan.combined.courier.courier_company_id,
        courier_name: plan.combined.courier.courier_name,
        service: plan.combined.courier.service,
      })
      continue
    }
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
            id: packedUnitId(method.shipping_option_id, unit.key, ordinal),
            title: line.title || line.variant_sku || "Product",
            shipping_option_id: method.shipping_option_id,
            location_id: quote.origin_location_id,
            items: [{ id: line.id, quantity: 1 }],
            measurements: unit.measurements,
            carrier_amount: unit.courier.amount,
            courier_company_id: unit.courier.courier_company_id,
            courier_name: unit.courier.courier_name,
            service: unit.courier.service,
          })
      }
    }
  }
  return jobs
}
