export const SHIPROCKET_ORDER_CANCELLED_EVENT = "shiprocket.order.cancelled"

export type ShiprocketOrderCancelledEvent = {
  sr_order_id: number
  order_id?: string
  before_awb: true
  current_status: string
  current_status_id?: number
  shipment_status: string
  shipment_status_id?: number
  current_timestamp?: string
}

const normalized = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
function code(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined
  if (!/^\d+$/.test(String(value).trim())) return undefined
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}
function matches(
  status: unknown,
  statusCode: unknown,
  labels: string[],
  codes: number[]
) {
  const label = normalized(status)
  const numericStatus = /^\d+$/.test(label)
  const hasCode =
    statusCode !== undefined && statusCode !== null && statusCode !== ""
  const explicitCode = hasCode ? code(statusCode) : undefined
  const valueCode = numericStatus ? code(status) : undefined
  if (hasCode && explicitCode === undefined) return false
  if (numericStatus && valueCode === undefined) return false
  if (label && !numericStatus && !labels.includes(label)) return false
  const observed = [explicitCode, valueCode].filter(
    (n): n is number => n !== undefined
  )
  return (
    !!(labels.includes(label) || observed.length) &&
    observed.every((n) => codes.includes(n))
  )
}

// Shiprocket's Orders and Shipments tables use different cancellation codes.
export const isCancelledOrderStatus = (status: unknown, statusCode?: unknown) =>
  matches(
    status,
    statusCode,
    [
      "CANCELED",
      "CANCELLED",
      "CANCELED BEFORE DISPATCHED",
      "CANCELLED BEFORE DISPATCHED",
    ],
    [5, 54]
  )
export const isPendingOrderCancellation = (
  status: unknown,
  statusCode?: unknown
) => matches(status, statusCode, ["CANCELLATION REQUESTED"], [18])
export const isCancelledShipmentStatus = (
  status: unknown,
  statusCode?: unknown
) =>
  matches(
    status,
    statusCode,
    [
      "CANCELED",
      "CANCELLED",
      "CANCELED BEFORE DISPATCHED",
      "CANCELLED BEFORE DISPATCHED",
    ],
    [8, 45]
  )
