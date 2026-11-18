import test from "node:test"
import assert from "node:assert/strict"
import { cancelFailedAwbOrder } from "../shared/failed-awb"
import { remoteFixture } from "../testing/existing-order"
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

function setup() {
  const remote = remoteFixture(expected, binding)
  const calls: string[] = []
  let readback: any
  const api = {
    get: async (url: string) => {
      calls.push("GET " + url)
      return { data: { data: readback || remote } }
    },
    post: async (url: string, data: any) => {
      calls.push("POST " + url)
      assert.deepEqual(data, { ids: [100] })
      readback = structuredClone(remote)
      readback.status = "CANCELED"
      readback.shipments.status = "CANCELED"
      return { data: { status: 200 } }
    },
  }
  const input = {
    binding,
    order_data: expected,
    native_order_id: "order_fixture",
    pickup_id: "123",
    courier_id: 2,
  }
  return { remote, calls, api, input }
}
test("verified unbooked cancellation requires a matching cancelled readback", async () => {
  const f = setup()
  assert.equal((await cancelFailedAwbOrder(f.api, f.input)).cancelled, true)
  assert.deepEqual(f.calls, [
    "GET /orders/show/100",
    "POST /orders/cancel",
    "GET /orders/show/100",
  ])
})
test("a confirmed AWB is never cancelled", async () => {
  const f = setup()
  f.remote.shipments.awb = "EXISTING"
  f.remote.shipments.courier_company_id = 2
  assert.deepEqual(await cancelFailedAwbOrder(f.api, f.input), {
    cancelled: false,
    awb: "EXISTING",
  })
  assert.equal(f.calls.length, 1)
})
for (const mutation of [
  (r: any) => (r.channel_order_id = "other"),
  (r: any) => (r.total = 1),
  (r: any) => (r.shipments.id = 43),
  (r: any) => (r.shipments.pickup_scheduled_date = "2026-11-16"),
  (r: any) => (r.status = "CANCELLATION REQUESTED"),
])
  test("uncertain or mismatched shipment cannot trigger cancellation", async () => {
    const f = setup()
    mutation(f.remote)
    await assert.rejects(() => cancelFailedAwbOrder(f.api, f.input))
    assert.ok(!f.calls.some((c) => c.startsWith("POST")))
  })
test("a successful cancel response without cancelled state cannot unlock retry", async () => {
  const f = setup()
  f.api.post = async () => ({ data: { status: 200 } })
  await assert.rejects(
    () => cancelFailedAwbOrder(f.api, f.input),
    /not confirmed/
  )
})
test("an AWB appearing during cancellation blocks replacement", async () => {
  const f = setup(),
    post = f.api.post
  f.api.post = async (url, data) => {
    f.remote.shipments.awb = "RACING_BOOKING"
    return post(url, data)
  }
  await assert.rejects(
    () => cancelFailedAwbOrder(f.api, f.input),
    /not confirmed/
  )
})
