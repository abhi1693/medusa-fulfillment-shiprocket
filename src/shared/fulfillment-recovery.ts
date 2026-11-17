import {
  reviewExistingOrder,
  SHIPROCKET_BUYER_DETAILS_ACCESS_MESSAGE,
  type ExistingOrderBinding,
} from "./existing-order"
import { CourierQuoteError } from "../providers/shiprocket/utils/courier-policy"
import {
  isCancelledOrderStatus,
  isPendingOrderCancellation,
} from "./order-cancellation"

const invalid = (message: string): never => {
  throw new CourierQuoteError(message)
}
const cancelled = (order: any) =>
  isCancelledOrderStatus(order.status, order.status_code)
export function retryReference(base: string, generation: number) {
  if (
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    generation > 99999999
  )
    return invalid("Shipment retry reference limit exceeded")
  return generation ? `${base.slice(0, 40)}_r${generation}` : base
}
function generation(base: string, reference: string): number | null {
  if (reference === base) return 0
  const prefix = base.slice(0, 40) + "_r",
    suffix = reference.slice(prefix.length)
  return reference.startsWith(prefix) && /^[1-9][0-9]{0,7}$/.test(suffix)
    ? Number(suffix)
    : null
}
/** Only exact, cryptographically scoped merchant references are eligible. Never choose a global latest order. */
export async function recoverFulfillmentAttempt(
  api: any,
  input: {
    native_order_id: string
    order_data: any
    pickup_id: string
    courier_id: number
    protected_order_ids: number[]
    reference_hint?: string
    no_previous_attempt?: boolean
    allow_cancel?: boolean
    allow_unassigned_resume?: boolean
  },
  beforeWrite?: () => void
): Promise<{
  reference: string
  resume?: ExistingOrderBinding
  cancelled_order_ids: number[]
  verified_attempts: number
  base_reference?: string
}> {
  const base = input.order_data.order_id,
    found: any[] = []
  const readOnly = input.allow_cancel === false
  if (readOnly && (!input.reference_hint || input.no_previous_attempt))
    return invalid(
      "A recorded shipment reference is required to verify its cancellation"
    )
  if (input.no_previous_attempt)
    return { reference: base, cancelled_order_ids: [], verified_attempts: 0 }
  const hint = input.reference_hint
  if (
    hint &&
    generation(base, hint) === null &&
    !(
      hint.startsWith(input.native_order_id + "-") &&
      /^\d{10}$/.test(hint.slice(input.native_order_id.length + 1))
    )
  )
    return invalid(
      "The saved shipment attempt reference does not belong to this fulfillment"
    )
  let complete = false
  for (let page = 1; page <= 20; page++) {
    const response = await api.get("/orders", {
      params: {
        page,
        per_page: 100,
        ...(hint ? { filter_by: "channel_order_id", filter: hint } : {}),
      },
    })
    const rows = response.data?.data
    if (!Array.isArray(rows))
      return invalid(
        "Shiprocket shipment history could not be verified; retry later"
      )
    for (const row of rows) {
      const ref = String(row.channel_order_id ?? "")
      const legacy =
        ref.startsWith(input.native_order_id + "-") &&
        /^\d{10}$/.test(ref.slice(input.native_order_id.length + 1))
      const n = generation(base, ref) ?? (legacy ? 0 : null)
      if (n !== null && (!hint || ref === hint))
        found.push({ id: Number(row.id), reference: ref, generation: n })
    }
    const pages = Number(response.data?.meta?.pagination?.total_pages)
    if (
      (Number.isSafeInteger(pages) && pages > 0 && page >= pages) ||
      (!Number.isSafeInteger(pages) && rows.length < 100) ||
      (pages === 0 && rows.length === 0)
    ) {
      complete = true
      break
    }
  }
  if (!complete)
    return invalid(
      "Shiprocket shipment history is incomplete; no replacement was created"
    )
  if (readOnly && !found.length)
    return invalid(
      "The recorded shipment was not found. Its cancellation must be verified before choosing other items"
    )
  if (hint && !found.length)
    return { reference: hint, cancelled_order_ids: [], verified_attempts: 0 }
  const ids = new Set<number>()
  const active: {
    binding: ExistingOrderBinding
    review: ReturnType<typeof reviewExistingOrder>
  }[] = []
  let highest = -1
  const confirmedCancelledIds: number[] = []
  for (const row of found) {
    if (!Number.isSafeInteger(row.id) || row.id <= 0 || ids.has(row.id))
      return invalid("Shiprocket returned ambiguous shipment attempts")
    if (!readOnly) beforeWrite?.()
    ids.add(row.id)
    highest = Math.max(highest, row.generation)
    const response = await api.get(`/orders/show/${row.id}`),
      remote = response.data?.data ?? response.data
    if (
      Number(remote?.id) !== row.id ||
      remote.channel_order_id !== row.reference
    )
      return invalid(
        "Shiprocket shipment identity changed; no replacement was created"
      )
    if (input.protected_order_ids.includes(row.id))
      return invalid(
        "This shipment is already linked to a native fulfillment. Use the existing fulfillment instead of creating another"
      )
    const shipments = Array.isArray(remote.shipments)
      ? remote.shipments
      : remote.shipments
        ? [remote.shipments]
        : []
    if (
      shipments.length !== 1 ||
      !Number.isSafeInteger(Number(shipments[0].id)) ||
      Number(shipments[0].id) <= 0
    )
      return invalid("The previous shipment cannot be identified safely")
    if (isPendingOrderCancellation(remote.status, remote.status_code)) {
      const awb = shipments[0].awb || shipments[0].awb_code
      const knownAwb =
        typeof awb === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(awb)
          ? ` with AWB ${awb}`
          : ""
      const shipmentStatus = Number(shipments[0].status_code)
      return invalid(
        `Shiprocket cancellation is pending for order ${row.id}, shipment ${Number(shipments[0].id)} (order status 18${Number.isSafeInteger(shipmentStatus) && shipmentStatus > 0 ? `, shipment status ${shipmentStatus}` : ""})${knownAwb}. Check this shipment in Shiprocket before retrying; no replacement was created.`
      )
    }
    if (cancelled(remote)) {
      const previousBooking = [
        "awb_assign_date",
        "awb_assigned_date",
        "pickup_scheduled_date",
        "pickup_generated_date",
      ].some((field) => {
        const value = shipments[0][field]
        return (
          value !== undefined &&
          value !== null &&
          !(typeof value === "string" && !value.trim())
        )
      })
      if (previousBooking)
        return invalid(
          "The cancelled shipment has booking or pickup history. Review its carrier cost/refund before creating another"
        )
      if (shipments[0].awb || shipments[0].awb_code)
        return invalid(
          "The cancelled shipment had an AWB. Confirm its carrier cost/refund before creating another"
        )
      confirmedCancelledIds.push(row.id)
      continue
    }
    if (readOnly)
      return invalid(
        "The previous shipment is still active. Retry its original items or confirm its cancellation before choosing other items"
      )
    const binding = {
      order_id: row.id,
      shipment_id: Number(shipments[0].id),
      merchant_reference: row.reference,
    }
    let detail: any
    if (
      /[xX*]/.test(String(remote.customer_phone ?? "")) ||
      !String(remote.customer_phone ?? "").replace(/\D/g, "")
    ) {
      const result = await api.get(`/shipments/${binding.shipment_id}`)
      detail = result.data?.data ?? result.data
    }
    const review = reviewExistingOrder(
      response.data,
      { ...input.order_data, order_id: row.reference },
      input.pickup_id,
      binding,
      input.native_order_id,
      input.courier_id,
      detail
    )
    if (!review.ready)
      return invalid(
        review.warnings.includes("buyer_details_access_denied")
          ? SHIPROCKET_BUYER_DETAILS_ACCESS_MESSAGE
          : "The previous shipment does not match this fulfillment: " +
              review.issues.join(", ")
      )
    active.push({ binding, review })
  }
  if (readOnly)
    return {
      reference: retryReference(base, highest + 1),
      base_reference: base,
      cancelled_order_ids: confirmedCancelledIds,
      verified_attempts: found.length,
    }
  const booked = active.filter((attempt) => attempt.review.awb)
  if (booked.length || (input.allow_unassigned_resume && active.length)) {
    if (active.length !== 1)
      return invalid(
        "Multiple active shipment attempts require review; no shipment was cancelled or created"
      )
    const { binding, review } = booked[0] ?? active[0]
    return {
      reference: binding.merchant_reference,
      resume: { ...binding, review_digest: review.digest },
      cancelled_order_ids: [],
      verified_attempts: found.length,
    }
  }
  if (active.length) {
    const { binding } = active[0]
    return invalid(
      `Shiprocket AWB assignment is still unconfirmed for order ${binding.order_id}, shipment ${binding.shipment_id}, reference ${binding.merchant_reference}. Check this same shipment in Shiprocket before retrying; no order was cancelled or replaced.`
    )
  }
  return {
    reference: retryReference(base, highest + 1),
    cancelled_order_ids: confirmedCancelledIds,
    verified_attempts: found.length,
  }
}
