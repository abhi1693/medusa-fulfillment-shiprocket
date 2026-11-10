import test from "node:test"
import assert from "node:assert/strict"
import {
  reviewExistingOrder,
  requireExistingOrderReview,
  validateExistingBinding,
} from "../shared/existing-order"
import { remoteFixture, shipmentDetailFixture } from "./fixtures/existing-order"
const binding = {
  order_id: 100,
  shipment_id: 42,
  merchant_reference: "order_fixture-1794263026",
}
const expected = {
  order_id: "medusa_fixture",
  shipping_customer_name: "Fixture",
  shipping_last_name: "Person",
  shipping_address: "Fixture street",
  shipping_address_2: "",
  shipping_city: "Delhi",
  shipping_state: "Delhi",
  shipping_pincode: "110077",
  shipping_country: "in",
  shipping_email: "fixture@example.test",
  shipping_phone: "9876543210",
  billing_customer_name: "Fixture",
  billing_last_name: "Person",
  billing_address: "Fixture street",
  billing_address_2: "",
  billing_city: "Delhi",
  billing_state: "Delhi",
  billing_pincode: "110077",
  billing_country: "in",
  billing_email: "fixture@example.test",
  billing_phone: "9876543210",
  sub_total: 100,
  total_discount: 20.5,
  shipping_charges: 100,
  giftwrap_charges: 0,
  transaction_charges: 0,
  order_items: [
    { sku: "fixture", units: 1, selling_price: 100, discount: 20.5, tax: 0 },
  ],
  weight: 1,
  length: 30,
  breadth: 20,
  height: 10,
}
const review = (remote: any, b: any = binding) =>
  reviewExistingOrder(remote, expected, "123", b, "order_fixture", 2)
test("existing order identity, invoice and parcel are verified without exposing recipient data", () => {
  const remote = remoteFixture(expected, binding),
    result = review(remote)
  assert.equal(result.ready, true, result.issues.join(","))
  requireExistingOrderReview(result, result.digest)
  assert.ok(!JSON.stringify(result).includes(expected.shipping_email))
  remote.updated_at = "volatile value"
  remote.seller_can_edit = true
  assert.equal(review(remote).digest, result.digest)
  remote.customer_phone = "+91 9876543210"
  remote.customer_country = "India"
  assert.equal(review(remote).ready, true)
})
test("every unsafe mismatch is a review failure, not an alternate creation instruction", () => {
  const mutations = [
    (r: any) => (r.id = 101),
    (r: any) => (r.channel_order_id = "foreign"),
    (r: any) => (r.pickup_location_id = 999),
    (r: any) => (r.total = 1),
    (r: any) => (r.discount = 0),
    (r: any) => (r.others.shipping_charges = 0),
    (r: any) => (r.products[0].quantity = 2),
    (r: any) => (r.products[0].selling_price = 1),
    (r: any) => (r.products[0].discount = 0),
    (r: any) => (r.products[0].tax_percentage = 18),
    (r: any) => (r.customer_email = "other@example.test"),
    (r: any) => (r.billing_address = "Different fixture"),
    (r: any) => (r.shipments.weight = 2),
    (r: any) => (r.shipments.dimensions = "1x2x3"),
    (r: any) => (r.shipments.id = 43),
    (r: any) => (r.status = "CANCELED"),
    (r: any) => (r.payment_method = "COD"),
    (r: any) => (r.currency = "USD"),
    (r: any) => {
      r.shipments.awb = "OTHER"
      r.shipments.courier_company_id = 3
    },
  ]
  for (const mutate of mutations) {
    const remote = remoteFixture(expected, binding)
    mutate(remote)
    const result = review(remote)
    assert.equal(result.ready, false)
    assert.throws(
      () => requireExistingOrderReview(result, result.digest),
      /does not match/
    )
  }
  const bad = review(remoteFixture(expected, binding), {
    ...binding,
    merchant_reference: "other-1794263026",
  })
  assert.ok(bad.issues.includes("merchant_reference.ownership"))
})
test("stale approval and invalid lookup IDs cannot be accepted", () => {
  const result = review(remoteFixture(expected, binding))
  assert.throws(
    () => requireExistingOrderReview(result, "a".repeat(64)),
    /changed/
  )
  for (const id of [0, -1, 1.2, "..", NaN])
    assert.throws(
      () => validateExistingBinding({ ...binding, order_id: id as any }),
      /Valid existing/
    )
})

test("masked API phones remain unverifiable and known city aliases are normalized", () => {
  const wanted = {
    ...expected,
    shipping_city: "Gurugram",
    billing_city: "Gurugram",
  }
  const remote = remoteFixture(wanted, binding)
  remote.customer_city = "Gurgaon"
  remote.billing_city = "Gurgaon"
  const inspect = () =>
    reviewExistingOrder(remote, wanted, "123", binding, "order_fixture", 2)
  assert.equal(inspect().ready, true)
  remote.customer_phone = "XXXXXXXXXX"
  remote.billing_phone = "XXXXXXXXXX"
  assert.deepEqual(inspect().issues, [
    "recipient.phone_unverifiable",
    "billing.phone_unverifiable",
  ])
})

test("documented shipment detail corroborates a redacted recipient but wrong identity or address cannot", () => {
  const remote = remoteFixture(expected, binding),
    detail = shipmentDetailFixture(expected, binding)
  remote.customer_phone = "XXXXXXXXXX"
  remote.billing_phone = "XXXXXXXXXX"
  const inspect = () =>
    reviewExistingOrder(
      remote,
      expected,
      "123",
      binding,
      "order_fixture",
      2,
      detail
    )
  assert.equal(inspect().ready, true)
  assert.deepEqual(inspect().warnings, ["billing.phone_redacted"])
  detail.order_id = 999
  assert.ok(inspect().issues.includes("recipient.phone_unverifiable"))
  detail.order_id = binding.order_id
  detail.shipping_address.address = "Different fixture"
  assert.ok(inspect().issues.includes("recipient.phone_unverifiable"))
})
