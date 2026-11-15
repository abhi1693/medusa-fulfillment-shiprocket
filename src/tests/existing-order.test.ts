import test from "node:test"
import assert from "node:assert/strict"
import {
  reviewExistingOrder,
  requireExistingOrderReview,
  SHIPROCKET_BUYER_DETAILS_ACCESS_MESSAGE,
  validateExistingBinding,
} from "../shared/existing-order"
import {
  remoteFixture,
  shipmentDetailFixture,
  sameAddressRemoteFixture,
} from "./fixtures/existing-order"
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

test("native province codes match carrier state names, including masked shipment-detail verification", () => {
  const wanted = {
    ...expected,
    shipping_state: "in-hr",
    billing_state: "in-hr",
  }
  const remote = remoteFixture(wanted, binding)
  remote.customer_state = "Haryana"
  remote.billing_state_name = "HARYANA"
  remote.customer_phone = "XXXXXXXXXX"
  const detail = shipmentDetailFixture(wanted, binding)
  detail.shipping_address.state = "Haryana"
  const result = reviewExistingOrder(
    remote,
    wanted,
    "123",
    binding,
    "order_fixture",
    2,
    detail
  )
  assert.equal(result.ready, true, result.issues.join(","))
  detail.shipping_address.state = "Delhi"
  assert.ok(
    reviewExistingOrder(
      remote,
      wanted,
      "123",
      binding,
      "order_fixture",
      2,
      detail
    ).issues.includes("recipient.phone_unverifiable")
  )
})
test("explicit original same-address flag corroborates omitted billing only after verifying the matching recipient", () => {
  const wanted = {
    ...expected,
    shipping_state: "in-hr",
    billing_state: "in-hr",
    shipping_is_billing: true,
  }
  const remote = sameAddressRemoteFixture(wanted, binding),
    detail = shipmentDetailFixture(wanted, binding)
  remote.customer_state = "Haryana"
  detail.shipping_address.state = "Haryana"
  const inspect = () =>
    reviewExistingOrder(
      remote,
      wanted,
      "123",
      binding,
      "order_fixture",
      2,
      detail
    )
  assert.equal(inspect().ready, true, inspect().issues.join(","))
  assert.deepEqual(inspect().warnings, ["billing.same_as_shipping"])
  assert(!JSON.stringify(inspect()).includes(wanted.shipping_email))
  remote.shipments.awb = "existing-awb"
  remote.shipments.courier_company_id = 2
  assert.equal(inspect().ready, true)
  detail.order_id = 999
  assert.equal(inspect().ready, false)
})
test("omitted billing is never inferred for different native billing details or partial contradictory remote data", () => {
  const wanted = { ...expected, shipping_is_billing: true }
  const remote = sameAddressRemoteFixture(wanted, binding),
    detail = shipmentDetailFixture(wanted, binding)
  for (const field of [
    "billing_customer_name",
    "billing_address",
    "billing_address_2",
    "billing_city",
    "billing_state",
    "billing_pincode",
    "billing_country",
    "billing_email",
    "billing_phone",
  ]) {
    const result = reviewExistingOrder(
      remote,
      { ...wanted, [field]: "different" },
      "123",
      binding,
      "order_fixture",
      2,
      detail
    )
    assert.equal(result.ready, false, field)
    assert(!result.warnings.includes("billing.same_as_shipping"), field)
  }
  remote.billing_address = "Contradictory billing address"
  assert.equal(
    reviewExistingOrder(
      remote,
      wanted,
      "123",
      binding,
      "order_fixture",
      2,
      detail
    ).ready,
    false
  )
})
test("same-address inference requires an explicit supported flag and matching native flag", () => {
  for (const flag of [undefined, false, "false", null]) {
    const wanted = { ...expected, shipping_is_billing: true },
      remote = sameAddressRemoteFixture(wanted, binding)
    remote.others.shipping_is_billing = flag
    assert.equal(
      reviewExistingOrder(
        remote,
        wanted,
        "123",
        binding,
        "order_fixture",
        2,
        shipmentDetailFixture(wanted, binding)
      ).ready,
      false
    )
  }
  for (const flag of [true, 1, "1"]) {
    const wanted = { ...expected, shipping_is_billing: true },
      remote = sameAddressRemoteFixture(wanted, binding)
    delete remote.others.shipping_is_billing
    remote.shipping_is_billing = flag
    assert.equal(
      reviewExistingOrder(
        remote,
        wanted,
        "123",
        binding,
        "order_fixture",
        2,
        shipmentDetailFixture(wanted, binding)
      ).ready,
      true
    )
    assert.equal(
      reviewExistingOrder(
        remote,
        { ...wanted, shipping_is_billing: false },
        "123",
        binding,
        "order_fixture",
        2,
        shipmentDetailFixture(wanted, binding)
      ).ready,
      false
    )
  }
})

function packedReviewFixture() {
  const wanted = { ...expected, shipping_is_billing: true, weight: 0.163 }
  const remote = sameAddressRemoteFixture(wanted, binding)
  remote.others.weight = "0.163"
  remote.shipments.weight = 0.16
  const detail = shipmentDetailFixture(wanted, binding)
  return {
    wanted,
    remote,
    detail,
    inspect: () =>
      reviewExistingOrder(
        remote,
        wanted,
        "123",
        binding,
        "order_fixture",
        2,
        detail
      ),
  }
}

test("original declared parcel weight corroborates rounded shipment weight alongside verified same-address billing", () => {
  const f = packedReviewFixture()
  const result = f.inspect()
  assert.equal(result.ready, true, result.issues.join(","))
  assert(result.warnings.includes("billing.same_as_shipping"))
  assert(result.warnings.includes("parcel.weight_original_projection"))
  requireExistingOrderReview(result, result.digest)
  f.remote.others.weight = 0.16300000000000003
  f.remote.shipments.weight = 0.16000000000000003
  assert.equal(f.inspect().ready, true)
})

test("original parcel corroboration never accepts contradictory or missing weight evidence", () => {
  for (const [original, shipment] of [
    [undefined, 0.16],
    [null, 0.16],
    [0.164, 0.16],
    [0.163001, 0.16],
    [0.16, 0.163],
    [0.163, 0.161],
    [0.163, 0.17],
  ]) {
    const f = packedReviewFixture()
    f.remote.others.weight = original
    f.remote.shipments.weight = shipment
    const result = f.inspect()
    assert.equal(result.ready, false)
    assert(result.issues.includes("parcel.weight"))
    assert(!result.warnings.includes("parcel.weight_original_projection"))
  }
})

test("known shipment buyer-data denial remains blocked with actionable API-user permission guidance", () => {
  const f = packedReviewFixture()
  for (const field of ["first_name", "last_name", "phone"])
    f.detail.customer_details[field] = "Not Authorized"
  for (const field of ["address", "address_2"])
    f.detail.shipping_address[field] = "Not Authorized"
  const result = f.inspect()
  assert.equal(result.ready, false)
  assert(result.issues.includes("recipient.phone_unverifiable"))
  assert(result.warnings.includes("buyer_details_access_denied"))
  assert.throws(
    () => requireExistingOrderReview(result, result.digest),
    (error: any) => {
      assert.match(error.message, /Buyer's Details Access.*Allowed/)
      assert(error.message.includes(SHIPROCKET_BUYER_DETAILS_ACCESS_MESSAGE))
      return true
    }
  )
  assert(!JSON.stringify(result).includes(f.wanted.shipping_phone))
})

test("foreign shipment details cannot establish a buyer-data permission diagnosis", () => {
  const f = packedReviewFixture()
  f.detail.customer_details.phone = "Not Authorized"
  f.detail.order_id = 999
  const result = f.inspect()
  assert.equal(result.ready, false)
  assert(result.issues.includes("recipient.phone_unverifiable"))
  assert(!result.warnings.includes("buyer_details_access_denied"))
})
