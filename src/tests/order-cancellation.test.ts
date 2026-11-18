import test from "node:test"
import assert from "node:assert/strict"
import {
  isCancelledOrderStatus,
  isCancelledShipmentStatus,
  isPendingOrderCancellation,
} from "../shared/order-cancellation"

test("order cancellation recognizes only its documented terminal status labels and codes", () => {
  for (const [label, code] of [
    ["CANCELED", 5],
    ["Cancelled", undefined],
    ["Canceled before Dispatched", 54],
    ["CANCELLED_BEFORE_DISPATCHED", "54"],
    [5, undefined],
    ["54", undefined],
    [undefined, 5],
  ])
    assert.equal(isCancelledOrderStatus(label, code), true)
  for (const [label, code] of [
    ["NEW", 5],
    ["SHIPPED", 54],
    ["CANCELED", 8],
    ["CANCELLED", 18],
    ["CANCELLED", "unknown"],
    [undefined, undefined],
    [0, undefined],
    ["unknown", 5],
    ["CANCELLED", true],
    ["CANCELLED", NaN],
  ])
    assert.equal(isCancelledOrderStatus(label, code), false)
})

test("shipment cancellation never borrows the order namespace's numeric codes", () => {
  assert.equal(isCancelledShipmentStatus("CANCELLED", 8), true)
  assert.equal(
    isCancelledShipmentStatus("CANCELLED_BEFORE_DISPATCHED", 45),
    true
  )
  assert.equal(isCancelledShipmentStatus(45), true)
  assert.equal(isCancelledShipmentStatus("CANCELLED", 5), false)
  assert.equal(isCancelledShipmentStatus("DELIVERED", 8), false)
  assert.equal(isCancelledShipmentStatus("CANCELLED", 16), false)
})

test("pending order cancellation is separate from a confirmed cancellation", () => {
  assert.equal(isPendingOrderCancellation("CANCELLATION REQUESTED", 18), true)
  assert.equal(isPendingOrderCancellation(18), true)
  assert.equal(isPendingOrderCancellation("CANCELED", 18), false)
  assert.equal(isPendingOrderCancellation("CANCELLATION REQUESTED", 5), false)
  assert.equal(isCancelledOrderStatus("CANCELLATION REQUESTED", 18), false)
})
