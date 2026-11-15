import { shipmentLineKey } from "./cart-shipment-plan"
import { signedCourierClaim } from "./quote-integrity"
import { moneyPaise, allocateMoney } from "./order-money"

type Row = Record<string, any>
export function orderShipmentAllocation(
  order: Row,
  optionId: string,
  selected: { id: string; quantity: number }[]
) {
  const methods = (order.shipping_methods || []).map((method: Row) => ({
    method,
    allocation: signedCourierClaim(method.data?.shiprocket_quote, true)?.quote
      ?.shipment_allocation,
  }))
  const target = methods.find(
    (value: Row) => value.method.shipping_option_id === optionId
  )
  if (!target?.allocation) return undefined
  const allocation = target.allocation
  const siblings = methods
    .filter((value: Row) => value.allocation?.plan_id === allocation.plan_id)
    .sort((a: Row, b: Row) =>
      a.allocation.group_id.localeCompare(b.allocation.group_id)
    )
  const groupIds = siblings.map((s: Row) => s.allocation.group_id)
  if (
    !Array.isArray(allocation.groups) ||
    groupIds.length !== allocation.groups.length ||
    new Set(groupIds).size !== groupIds.length ||
    allocation.groups.some((g: string) => !groupIds.includes(g))
  )
    throw Error("The order has an incomplete shipment allocation")
  const orderLines = (order.items || []).filter(
    (line: Row) => line.requires_shipping !== false
  )
  const byKey = new Map<string, Row[]>()
  for (const line of orderLines) {
    const key = shipmentLineKey(line)
    byKey.set(
      key,
      [...(byKey.get(key) || []), line].sort((a, b) => a.id.localeCompare(b.id))
    )
  }
  const assigned: {
    line: Row
    quantity: number
    offset: number
    fulfilled: number
  }[] = []
  for (const [key, lines] of byKey) {
    const entries = siblings.flatMap((s: Row) =>
      s.allocation.items
        .filter((i: Row) => i.key === key)
        .map((i: Row) => ({ ...i, option: s.method.shipping_option_id }))
    )
    if (!entries.length) continue
    const ordered = lines.reduce((sum, line) => sum + Number(line.quantity), 0)
    if (
      entries.reduce((sum: number, e: Row) => sum + Number(e.quantity), 0) !==
      ordered
    )
      throw Error("Shipment quantities no longer match the native order")
    let cursor = 0
    for (const entry of entries) {
      let start = cursor,
        end = cursor + Number(entry.quantity),
        offset = 0
      for (const line of lines) {
        const count = Math.max(
          0,
          Math.min(end, offset + Number(line.quantity)) -
            Math.max(start, offset)
        )
        if (count && entry.option === optionId) {
          const fulfilled = (order.fulfillments || [])
            .filter(
              (f: Row) => f.shipping_option_id === optionId && !f.canceled_at
            )
            .flatMap((f: Row) => f.items || [])
            .filter((i: Row) => i.line_item_id === line.id)
            .reduce((sum: number, i: Row) => sum + Number(i.quantity), 0)
          assigned.push({
            line,
            quantity: count,
            offset: Math.max(start - offset, 0),
            fulfilled,
          })
        }
        offset += Number(line.quantity)
      }
      cursor = end
    }
  }
  if (!assigned.length)
    throw Error("No native items match the saved shipment allocation")
  for (const item of selected) {
    const line = assigned.find((i) => i.line.id === item.id)
    if (
      !line ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity <= 0 ||
      item.quantity > line.quantity - line.fulfilled
    )
      throw Error(
        "Fulfillment items exceed this warehouse's saved shipment allocation"
      )
  }
  const portion = (
    value: unknown,
    total: number,
    offset: number,
    count: number
  ) => Number(allocateMoney(moneyPaise(value), total, offset, count)) / 100
  return assigned.map(({ line, quantity, offset, fulfilled }) => ({
    ...line,
    quantity,
    original_total: portion(
      line.original_total,
      Number(line.quantity),
      offset,
      quantity
    ),
    total: portion(line.total, Number(line.quantity), offset, quantity),
    tax_total: portion(line.tax_total, Number(line.quantity), offset, quantity),
    original_tax_total: portion(
      line.original_tax_total,
      Number(line.quantity),
      offset,
      quantity
    ),
    detail: { ...line.detail, fulfilled_quantity: fulfilled },
  }))
}
