import { createHash } from "node:crypto"
import type { MedusaContainer } from "@medusajs/framework/types"
import { listShippingOptionsForCartWorkflow } from "@medusajs/medusa/core-flows"
import { shiprocketCartFingerprint } from "./cart-shipping"

type Row = Record<string, any>
export type ShipmentItem = {
  key: string
  variant_id: string
  quantity: number
}
export type ShipmentAllocation = {
  plan_id: string
  groups: string[]
  group_id: string
  profile_id: string
  location_id: string
  items: ShipmentItem[]
  cart_items: { id: string; quantity: number }[]
}
function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable(value[k])])
    )
  return value
}
const digest = (value: any) =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex")
export function shipmentLineKey(item: Row): string {
  return digest([
    item.variant_id || item.variant?.id,
    Number(item.unit_price),
    !!item.is_tax_inclusive,
    item.metadata || {},
  ])
}
export function allocateShipments(
  items: Row[],
  options: Row[],
  fingerprint: string
): Record<string, ShipmentAllocation> {
  const result: Record<string, ShipmentAllocation> = {}
  for (const profile of [
    ...new Set(
      items.map((i) => i.product?.shipping_profile?.id).filter(Boolean)
    ),
  ].sort()) {
    const lines = items
      .filter(
        (i) =>
          i.product?.shipping_profile?.id === profile &&
          i.requires_shipping !== false
      )
      .sort((a, b) => a.id.localeCompare(b.id))
    const eligible = options.filter(
      (o) =>
        o.shipping_profile_id === profile &&
        o.provider_id?.endsWith("_shiprocket")
    )
    const locations = [
      ...new Set(
        eligible
          .map((o) => o.service_zone?.fulfillment_set?.location?.id)
          .filter(Boolean)
      ),
    ].sort() as string[]
    if (!lines.length || !locations.length) continue
    const levels = new Map<string, number>()
    const requirements = (line: Row) =>
      line.variant?.manage_inventory && !line.variant?.allow_backorder
        ? (line.variant.inventory_items || []).filter(
            (r: Row) => r.inventory?.requires_shipping !== false
          )
        : []
    for (const line of lines)
      for (const r of requirements(line))
        for (const l of r.inventory?.location_levels || []) {
          const available = Number(
            l.available_quantity ??
              Number(l.stocked_quantity) - Number(l.reserved_quantity)
          )
          levels.set(
            `${r.inventory_item_id}:${l.location_id}`,
            Number.isFinite(available) ? Math.max(0, available) : 0
          )
        }
    const capacity = (
      line: Row,
      location: string,
      ledger: Map<string, number>
    ) => {
      const rs = requirements(line)
      if (
        line.variant?.manage_inventory &&
        !line.variant?.allow_backorder &&
        !rs.length
      )
        return 0
      return rs.reduce((cap: number, r: Row) => {
        const required = Number(r.required_quantity ?? 1)
        if (!Number.isFinite(required) || required <= 0) return 0
        return Math.min(
          cap,
          Math.floor(
            ((ledger.get(`${r.inventory_item_id}:${location}`) || 0) + 1e-9) /
              required
          )
        )
      }, Number(line.quantity))
    }
    const consume = (
      line: Row,
      location: string,
      quantity: number,
      ledger: Map<string, number>
    ) => {
      for (const r of requirements(line)) {
        const key = `${r.inventory_item_id}:${location}`
        ledger.set(
          key,
          (ledger.get(key) || 0) - quantity * Number(r.required_quantity ?? 1)
        )
      }
    }
    const fits = (location: string) => {
      const ledger = new Map(levels)
      return lines.every((line) => {
        if (capacity(line, location, ledger) < line.quantity) return false
        consume(line, location, line.quantity, ledger)
        return true
      })
    }
    // Preserve existing single-warehouse alternatives whenever one can fulfill
    // the whole profile. Split only when separate origins are necessary.
    if (locations.some(fits)) continue
    const remaining = new Map(
      lines.map((line) => [line.id, Number(line.quantity)])
    )
    const groups: {
      location: string
      items: { id: string; quantity: number }[]
    }[] = []
    while ([...remaining.values()].some((q) => q > 0)) {
      const candidates = locations
        .map((location) => {
          const ledger = new Map(levels),
            selected: { id: string; quantity: number }[] = []
          for (const line of lines) {
            const quantity = Math.min(
              remaining.get(line.id) || 0,
              capacity(line, location, ledger)
            )
            if (quantity > 0) {
              consume(line, location, quantity, ledger)
              selected.push({ id: line.id, quantity })
            }
          }
          return {
            location,
            ledger,
            selected,
            quantity: selected.reduce((sum, i) => sum + i.quantity, 0),
          }
        })
        .sort(
          (a, b) =>
            b.quantity - a.quantity || a.location.localeCompare(b.location)
        )
      const best = candidates[0]
      if (!best?.quantity)
        throw Error(
          "The cart cannot be allocated to the available shipping locations. Review stock availability."
        )
      for (const [key, value] of best.ledger) levels.set(key, value)
      for (const item of best.selected)
        remaining.set(item.id, (remaining.get(item.id) || 0) - item.quantity)
      groups.push({ location: best.location, items: best.selected })
    }
    const planId = digest([fingerprint, profile, groups])
    for (const option of eligible) {
      const location = option.service_zone.fulfillment_set.location.id
      const group: {
        location: string
        items: { id: string; quantity: number }[]
      } = groups.find((g) => g.location === location) || {
        location,
        items: [],
      }
      result[option.id] = {
        plan_id: planId,
        groups: groups.map((g) => `${profile}:${g.location}`).sort(),
        group_id: `${profile}:${group.location}`,
        profile_id: profile,
        location_id: group.location,
        cart_items: group.items,
        items: [
          ...group.items
            .reduce((map, i) => {
              const line = lines.find((l) => l.id === i.id)!,
                key = shipmentLineKey(line),
                previous = map.get(key)
              map.set(key, {
                key,
                variant_id: line.variant_id,
                quantity: (previous?.quantity || 0) + i.quantity,
              })
              return map
            }, new Map<string, ShipmentItem>())
            .values(),
        ],
      }
    }
  }
  return result
}
export async function cartShipmentPlan(
  container: MedusaContainer,
  cartId: string
): Promise<Record<string, ShipmentAllocation>> {
  const {
    data: [cart],
  } = await container.resolve("query").graph({
    entity: "cart",
    filters: { id: cartId },
    fields: [
      "id",
      "currency_code",
      "shipping_address.country_code",
      "shipping_address.postal_code",
      "items.id",
      "items.variant_id",
      "items.product_id",
      "items.quantity",
      "items.unit_price",
      "items.is_tax_inclusive",
      "items.metadata",
      "items.requires_shipping",
      "items.product.shipping_profile.id",
      "items.variant.manage_inventory",
      "items.variant.allow_backorder",
      "items.variant.inventory_items.inventory_item_id",
      "items.variant.inventory_items.required_quantity",
      "items.variant.inventory_items.inventory.requires_shipping",
      "items.variant.inventory_items.inventory.location_levels.*",
    ],
  })
  if (!cart?.items?.length) return {}
  const { result: options } = await listShippingOptionsForCartWorkflow(
    container
  ).run({ input: { cart_id: cartId } })
  const fingerprint = shiprocketCartFingerprint(cart)
  if (!fingerprint) throw Error("Cannot verify shipping cart")
  return allocateShipments(cart.items, options as Row[], fingerprint)
}
export function scopedShipmentContext(context: Row, optionId: unknown): Row {
  const plan = context.shiprocket_shipment_allocations
  if (!plan || !Object.keys(plan).length) return context
  const allocation = plan[String(optionId)] as ShipmentAllocation | undefined
  // An unrelated profile may still use ordinary single-location shipping.
  if (!allocation) return context
  if (!allocation.cart_items.length)
    throw Error("This warehouse is not part of the shipment allocation")
  if (allocation.location_id !== context.from_location?.id)
    throw Error("Shipment origin changed. Select delivery again.")
  const items = allocation.cart_items.map((i) => {
    const line = context.items?.find((l: Row) => l.id === i.id)
    if (!line || i.quantity > line.quantity)
      throw Error("Shipment quantities changed. Select delivery again.")
    return { ...line, quantity: i.quantity }
  })
  return { ...context, items, shiprocket_shipment_allocation: allocation }
}
