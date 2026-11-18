import {
  reviewExistingOrder,
  type ExistingOrderBinding,
} from "./existing-order"
import {
  isCancelledOrderStatus,
  isPendingOrderCancellation,
} from "./order-cancellation"

/** Only a verified, unbooked order created by this attempt may be cancelled. */
export async function cancelFailedAwbOrder(
  api: any,
  input: {
    binding: ExistingOrderBinding
    order_data: any
    native_order_id: string
    pickup_id: string
    courier_id: number
  }
) {
  const { binding } = input
  const response = await api.get(`/orders/show/${binding.order_id}`)
  const remote = response.data?.data ?? response.data
  if (isPendingOrderCancellation(remote?.status, remote?.status_code))
    throw Error("Shiprocket cancellation is pending")
  let detail: any
  if (
    /[xX*]/.test(String(remote?.customer_phone ?? "")) ||
    !String(remote?.customer_phone ?? "").replace(/\D/g, "")
  ) {
    const shipment = await api.get(`/shipments/${binding.shipment_id}`)
    detail = shipment.data?.data ?? shipment.data
  }
  const review = reviewExistingOrder(
    response.data,
    input.order_data,
    input.pickup_id,
    binding,
    input.native_order_id,
    input.courier_id,
    detail
  )
  if (!review.ready)
    throw Error("Shipment verification failed: " + review.issues.join(", "))
  if (review.awb) return { cancelled: false, awb: review.awb }
  const shipments = Array.isArray(remote.shipments)
    ? remote.shipments
    : [remote.shipments]
  const booked = (shipment: any) =>
    [
      "awb_assign_date",
      "awb_assigned_date",
      "pickup_scheduled_date",
      "pickup_generated_date",
    ].some((field) => {
      const value = shipment?.[field]
      return (
        value !== undefined &&
        value !== null &&
        !(typeof value === "string" && !value.trim())
      )
    })
  if (shipments.some(booked))
    throw Error("Shipment has booking or pickup history")
  await api.post(
    "/orders/cancel",
    { ids: [binding.order_id] },
    { shiprocket_order_id: input.native_order_id }
  )
  const readback = await api.get(`/orders/show/${binding.order_id}`)
  const cancelled = readback.data?.data ?? readback.data
  const remaining = Array.isArray(cancelled?.shipments)
    ? cancelled.shipments
    : [cancelled?.shipments]
  if (
    Number(cancelled?.id) !== binding.order_id ||
    cancelled?.channel_order_id !== binding.merchant_reference ||
    !isCancelledOrderStatus(cancelled?.status, cancelled?.status_code) ||
    remaining.length !== 1 ||
    Number(remaining[0]?.id) !== binding.shipment_id ||
    remaining[0]?.awb ||
    remaining[0]?.awb_code ||
    remaining.some(booked)
  )
    throw Error("Shiprocket cancellation is not confirmed")
  return { cancelled: true, awb: "" }
}
