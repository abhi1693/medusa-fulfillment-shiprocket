import { createHash } from "node:crypto"
import { BigNumber } from "@medusajs/framework/utils"
export type FinancialLine = {
  id: string
  quantity: number
  fulfilled_quantity: number
  original_total: unknown
  total: unknown
  tax_total: unknown
  original_tax_total: unknown
  tax_rates: number[]
}
export type FulfillmentFinancials = {
  currency_code: string
  shipping_total: unknown
  shipping_tax_total?: unknown
  lines: FinancialLine[]
  selected_items: { id: string; quantity: number }[]
}
// Currency conversion is only between an exact internal paise representation
// and INR major units. Native Medusa v2 amounts are already major units.
export function moneyPaise(value: unknown): bigint {
  const text =
    value instanceof BigNumber
      ? (value.bigNumber?.toFixed() ?? String(value))
      : typeof value === "number" || typeof value === "string"
        ? String(value)
        : ""
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(text)
  if (!match)
    throw Error(
      "Invalid native INR order amount. Review the order before fulfilling."
    )
  const fraction = match[2] || "",
    amount =
      BigInt(match[1]) * 100n +
      BigInt(fraction.slice(0, 2).padEnd(2, "0")) +
      (Number(fraction[2] || 0) >= 5 ? 1n : 0n)
  if (amount > BigInt(Number.MAX_SAFE_INTEGER))
    throw Error("Order amount exceeds supported currency precision.")
  return amount
}
const major = (value: bigint) => Number(value) / 100
function integer(value: unknown, label: string, zero = false) {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < (zero ? 0 : 1))
    throw Error(`Invalid ${label}. Review the fulfillment quantities.`)
  return n
}
export function allocateMoney(
  total: bigint,
  ordered: number,
  fulfilled: number,
  selected: number
): bigint {
  const q = integer(ordered, "ordered quantity"),
    f = integer(fulfilled, "fulfilled quantity", true),
    n = integer(selected, "selected quantity")
  if (f + n > q)
    throw Error("Selected quantities exceed the remaining order items.")
  return (total * BigInt(f + n)) / BigInt(q) - (total * BigInt(f)) / BigInt(q)
}
export function financialSnapshot(
  order: any,
  method: any,
  selected: any[],
  profileId?: string
): FulfillmentFinancials {
  const lines = (order.items || [])
    .filter(
      (line: any) =>
        line.requires_shipping !== false &&
        (!profileId ||
          line.variant?.product?.shipping_profile?.id === profileId)
    )
    .map((line: any) => ({
      id: line.id,
      quantity: line.quantity,
      fulfilled_quantity: line.detail?.fulfilled_quantity ?? 0,
      original_total: line.original_total,
      total: line.total,
      tax_total: line.tax_total,
      original_tax_total: line.original_tax_total,
      tax_rates: (line.tax_lines || []).map((tax: any) => Number(tax.rate)),
    }))
  return {
    currency_code: order.currency_code,
    shipping_total: method?.total,
    shipping_tax_total: method?.tax_total,
    lines,
    selected_items: selected,
  }
}
export function shiprocketOrderMoney(input: FulfillmentFinancials) {
  if (input?.currency_code?.toLowerCase() !== "inr")
    throw Error("Shiprocket order values require native INR amounts.")
  if (!input.lines?.length || !input.selected_items?.length)
    throw Error(
      "Native order financial details and selected item quantities are required."
    )
  const lines = [...input.lines].sort((a, b) => a.id.localeCompare(b.id))
  if (
    new Set(lines.map((l) => l.id)).size !== lines.length ||
    new Set(input.selected_items.map((l) => l.id)).size !==
      input.selected_items.length
  )
    throw Error("Duplicate order lines cannot be allocated twice.")
  const validated = lines.map((line) => {
    const quantity = integer(line.quantity, "ordered quantity"),
      fulfilled = integer(line.fulfilled_quantity, "fulfilled quantity", true)
    const gross = moneyPaise(line.original_total),
      net = moneyPaise(line.total),
      tax = moneyPaise(line.tax_total),
      originalTax = moneyPaise(line.original_tax_total)
    if (net > gross || tax > net || originalTax > gross || fulfilled > quantity)
      throw Error(
        "Native item totals are inconsistent. Review the order before fulfilling."
      )
    // The API's selling_price is per unit and includes GST. Never round it to
    // whole rupees or silently submit a unit price inconsistent with its line.
    if (gross % BigInt(quantity) !== 0n)
      throw Error(
        "This tax-inclusive unit price cannot be represented exactly to paise. Review its rounding before fulfilling."
      )
    const rate = (line.tax_rates || []).reduce((sum, n) => sum + n, 0)
    if (!Number.isFinite(rate) || rate < 0 || rate > 100)
      throw Error("Invalid native tax rate.")
    return { ...line, quantity, fulfilled, gross, net, tax, rate }
  })
  const shipping = moneyPaise(input.shipping_total)
  const shippingTax =
    input.shipping_tax_total === undefined && shipping === 0n
      ? 0n
      : moneyPaise(input.shipping_tax_total)
  if (shippingTax > shipping)
    throw Error("Native shipping tax exceeds its charged total.")
  const valueWeight = validated.reduce((sum, l) => sum + l.net, 0n)
  const weights = validated.map((line) =>
    valueWeight ? line.net : BigInt(line.quantity)
  )
  const totalWeight = weights.reduce((sum, n) => sum + n, 0n)
  let previousWeight = 0n
  const shares = new Map<string, bigint>()
  const taxShares = new Map<string, bigint>()
  let allocatedShipping = 0n
  validated.forEach((line, index) => {
    const next = previousWeight + weights[index]
    const share =
      (shipping * next) / totalWeight -
      (shipping * previousWeight) / totalWeight
    shares.set(line.id, share)
    taxShares.set(
      line.id,
      shipping
        ? (shippingTax * (allocatedShipping + share)) / shipping -
            (shippingTax * allocatedShipping) / shipping
        : 0n
    )
    allocatedShipping += share
    previousWeight = next
  })
  let netTotal = 0n,
    discountTotal = 0n,
    taxTotal = 0n,
    shippingTotal = 0n
  const items = input.selected_items.map((selected) => {
    const line = validated.find((value) => value.id === selected.id)
    if (!line)
      throw Error(
        "Selected item does not belong to this shipping method's financial allocation."
      )
    const n = integer(selected.quantity, "selected quantity")
    const gross = allocateMoney(line.gross, line.quantity, line.fulfilled, n),
      net = allocateMoney(line.net, line.quantity, line.fulfilled, n),
      netBefore = (line.net * BigInt(line.fulfilled)) / BigInt(line.quantity),
      tax = line.net
        ? (line.tax * (netBefore + net)) / line.net -
          (line.tax * netBefore) / line.net
        : 0n
    const delivery = allocateMoney(
      shares.get(line.id)!,
      line.quantity,
      line.fulfilled,
      n
    )
    const shippingShare = shares.get(line.id)!,
      shippingTaxShare = taxShares.get(line.id) || 0n
    const deliveryBefore =
      (shippingShare * BigInt(line.fulfilled)) / BigInt(line.quantity)
    const deliveryTax = shippingShare
      ? (shippingTaxShare * (deliveryBefore + delivery)) / shippingShare -
        (shippingTaxShare * deliveryBefore) / shippingShare
      : 0n
    netTotal += net
    discountTotal += gross - net
    taxTotal += tax + deliveryTax
    shippingTotal += delivery
    return {
      line_item_id: line.id,
      units: n,
      selling_price: major(line.gross / BigInt(line.quantity)),
      discount: major(gross - net),
      tax: line.rate,
    }
  })
  return {
    items,
    // Shiprocket applies total_discount and shipping_charges to this gross
    // goods subtotal. Sending the already-discounted grand total discounts twice.
    sub_total: major(netTotal + discountTotal),
    order_total: major(netTotal + shippingTotal),
    total_discount: major(discountTotal),
    shipping_charges: major(shippingTotal),
    giftwrap_charges: 0,
    transaction_charges: 0,
    summary: {
      goods_total: major(netTotal),
      tax_total: major(taxTotal),
      shipping_total: major(shippingTotal),
      discount_total: major(discountTotal),
      currency_code: "inr",
    },
  }
}
export function stableFulfillmentReference(
  orderId: string,
  optionId: string,
  input: FulfillmentFinancials
) {
  const rows = input.selected_items
    .map((selected) => ({
      id: selected.id,
      quantity: selected.quantity,
      fulfilled_before: input.lines.find((l) => l.id === selected.id)
        ?.fulfilled_quantity,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return (
    "medusa_" +
    createHash("sha256")
      .update(JSON.stringify([orderId, optionId, rows]))
      .digest("hex")
      .slice(0, 40)
  )
}
