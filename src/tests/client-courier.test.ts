import { remoteFixture } from "./fixtures/existing-order"
import test from "node:test"
import assert from "node:assert/strict"
import axios from "axios"
import ShiprocketClient from "../providers/shiprocket/client"
import { resetShiprocketManager } from "../providers/shiprocket/client/manager"
const courier = {
  is_surface: false,
  courier_company_id: 2,
  courier_name: "Fixture courier",
  rate: 50,
  rating: 4.8,
  estimated_delivery_days: "3",
  realtime_tracking: "Real Time",
  pod_available: "Instant",
  call_before_delivery: "Available",
}
const order = {
  id: "order_fixture",
  currency_code: "inr",
  shipping_methods: [{ shipping_option_id: "option", total: 0 }],
  created_at: "2026-11-09T00:00:00Z",
  customer: { email: "fixture@example.test" },
  shipping_address: {
    first_name: "Fixture",
    last_name: "Merchant",
    address_1: "Fixture address",
    city: "Delhi",
    postal_code: "110077",
    province: "Delhi",
    country_code: "in",
    phone: "9876543210",
  },
  items: [
    {
      id: "item_fixture",
      quantity: 2,
      requires_shipping: true,
      original_total: 200,
      total: 200,
      tax_total: 0,
      original_tax_total: 0,
      tax_lines: [],
      detail: { fulfilled_quantity: 0 },
      unit_price: 100,
      variant: {
        sku: "fixture",
        weight: 520,
        length: 30,
        width: 140,
        height: 120,
      },
    },
  ],
}
const items = [
  { line_item_id: "item_fixture", title: "Fixture product", quantity: 1 },
]
const pickup: any = {
  nickname: "fixture",
  postcode: "110077",
  external_id: "123",
}
function setup(t: any, options: any = {}) {
  const previous = axios.defaults.adapter
  resetShiprocketManager()
  const calls: any[] = []
  let rows: any[] = [courier]
  let awbResponse: any
  let createFailure: any
  let orderPages: any[] = []
  let existing: any
  axios.defaults.adapter = async (config: any) => {
    calls.push({
      url: config.url,
      order_id: config.shiprocket_order_id,
      params: config.params,
      data:
        typeof config.data === "string" ? JSON.parse(config.data) : config.data,
    })
    let data: any
    if (config.url === "/auth/login")
      data = { token: "generated-fixture-token" }
    else if (config.url === "/settings/company/pickup") {
      assert.equal(config.params.id, "123")
      data = [
        { id: 123, pickup_location: "current-name-by-id", pin_code: "110077" },
      ]
    } else if (config.url === "/courier/serviceability/")
      data = { data: { available_courier_companies: rows } }
    else if (config.url === "/orders/create/adhoc") {
      if (createFailure) throw createFailure
      data = { order_id: 100, shipment_id: 42 }
    } else if (config.url === "/courier/assign/awb")
      data = awbResponse ?? {
        awb_assign_status: 1,
        response: {
          data: {
            awb_code: "FIXTURE",
            courier_company_id: 2,
            courier_name: "Fixture courier",
          },
        },
      }
    else if (config.url === "/orders")
      data = orderPages[Number(config.params.page) - 1]
    else if (config.url === "/orders/show/100") data = { data: existing }
    else if (config.url === "/courier/generate/pickup")
      data = { pickup_status: 1 }
    else throw Error("Unexpected operation")
    return { config, data, status: 200, statusText: "OK", headers: {} }
  }
  t.after(() => {
    axios.defaults.adapter = previous
    resetShiprocketManager()
  })
  return {
    client: new ShiprocketClient({
      mode: "test",
      email: "fixture@example.test",
      password: "fixture",
      ...options,
    }),
    calls,
    setAwbResponse: (value: any) => (awbResponse = value),
    setOrderPages: (value: any[]) => (orderPages = value),
    setExisting: (value: any) => (existing = value),
    setRows: (value: any[]) => (rows = value),
    setCreateFailure: (value: any) => (createFailure = value),
  }
}
test("quote cache includes courier identity and capability gates stay out of query parameters", async (t) => {
  const f = setup(t)
  const input = {
    pickup_postcode: "110077",
    delivery_postcode: "110077",
    weight: 0.52,
    cod: 0,
    allowed_courier_ids: [2],
  }
  const quote = await f.client.quote(input)
  assert.equal(quote.estimated_delivery_days, "3")
  assert.equal((await f.client.quote(input, quote)).courier_company_id, 2)
  assert.equal(
    f.calls.filter((c) => c.url === "/courier/serviceability/").length,
    1
  )
  assert.equal(
    f.calls.find((c) => c.params)?.params.allowed_courier_ids,
    undefined
  )
})
test("fulfillment revalidates before remote creation and explicitly assigns the quoted courier", async (t) => {
  const f = setup(t)
  await f.client.create({}, items, order, pickup, {
    courier_company_id: 2,
    amount: 50,
  })
  assert.equal(
    f.calls.find((c) => c.url === "/orders/create/adhoc").order_id,
    order.id
  )
  assert.equal(
    f.calls.find((c) => c.url === "/courier/assign/awb").order_id,
    order.id
  )
  const operation = f.calls.map((c) => c.url)
  assert.ok(
    operation.indexOf("/courier/serviceability/") <
      operation.indexOf("/orders/create/adhoc")
  )
  assert.equal(
    f.calls.find((c) => c.url === "/courier/assign/awb").data.courier_id,
    2
  )
  assert.equal(
    f.calls.find((c) => c.url === "/orders/create/adhoc").data.length,
    3
  )
  assert.equal(
    f.calls.find((c) => c.url === "/orders/create/adhoc").data.pickup_location,
    "current-name-by-id"
  )
})
test("lost eligibility or changed price never creates an order or switches carrier", async (t) => {
  const f = setup(t)
  for (const rows of [
    [],
    [{ ...courier, rate: 60 }],
    [{ ...courier, courier_company_id: 3 }],
  ]) {
    f.setRows(rows)
    await assert.rejects(() =>
      f.client.create({}, items, order, pickup, {
        courier_company_id: 2,
        amount: 50,
      })
    )
  }
  assert.equal(
    f.calls.filter((c) => c.url === "/orders/create/adhoc").length,
    0
  )
})
test("multi-item fulfillment requires a measured parcel rather than an invented box", async (t) => {
  const f = setup(t)
  await assert.rejects(
    () =>
      f.client.create({}, [{ ...items[0], quantity: 2 }], order, pickup, {
        courier_company_id: 2,
        amount: 50,
      }),
    /Measured packed parcel/
  )
  assert.equal(f.calls.length, 0)
  await f.client.create(
    {},
    [{ ...items[0], quantity: 2 }],
    order,
    pickup,
    { courier_company_id: 2, amount: 50 },
    { weight_grams: 1200, length_mm: 300, width_mm: 200, height_mm: 100 }
  )
  const request = f.calls.find(
    (c) => c.url === "/courier/serviceability/"
  ).params
  assert.equal(request.weight, 1.2)
  assert.equal(request.length, 30)
})

test("preference fallback consumes one carrier list without extra API calls", async (t) => {
  const f = setup(t, {
    preferred_real_time_tracking: true,
    preferred_pod: "instant",
    preferred_call_before_delivery: true,
  })
  f.setRows([
    {
      ...courier,
      realtime_tracking: undefined,
      pod_available: undefined,
      call_before_delivery: undefined,
    },
  ])
  const quote = await f.client.quote({
    pickup_postcode: "110077",
    delivery_postcode: "110077",
    weight: 0.52,
    cod: 0,
  })
  assert.deepEqual(quote.relaxed_preferences, [
    "call_before_delivery",
    "pod",
    "real_time_tracking",
  ])
  assert.equal(
    f.calls.filter((c) => c.url === "/courier/serviceability/").length,
    1
  )
})

test("merchant fulfillment budget accepts a changed rate while preserving courier and stored carrier cost", async (t) => {
  const f = setup(t)
  f.setRows([{ ...courier, rate: 55 }])
  let beforeCreate = 0
  const result: any = await f.client.create(
    {},
    items,
    order,
    pickup,
    { courier_company_id: 2, amount: 50, service: "air" },
    undefined,
    undefined,
    (actual) => {
      assert.ok(actual.amount <= 60)
    },
    () => {
      beforeCreate++
    }
  )
  assert.equal(result.shiprocket_carrier_cost.amount, 55)
  assert.equal(result.courier_company_id, 2)
  assert.equal(beforeCreate, 1)
})
test("over-budget and wrong-courier quotes cannot create a remote shipment or consume the attempt", async (t) => {
  const f = setup(t)
  let attempted = false
  for (const row of [
    { ...courier, rate: 61 },
    { ...courier, courier_company_id: 3 },
  ]) {
    f.setRows([row])
    await assert.rejects(() =>
      f.client.create(
        {},
        items,
        order,
        pickup,
        { courier_company_id: 2, amount: 50, service: "air" },
        undefined,
        undefined,
        (actual) => {
          if (actual.amount > 60) throw Error("Over budget")
        },
        () => {
          attempted = true
        }
      )
    )
  }
  assert.equal(attempted, false)
  assert.ok(!f.calls.some((c) => c.url === "/orders/create/adhoc"))
})

test("an uncertain order-creation timeout never instructs a blind retry or assigns an AWB", async (t) => {
  const f = setup(t)
  f.setCreateFailure(
    Object.assign(new Error("timeout"), { code: "ECONNABORTED" })
  )
  await assert.rejects(
    () =>
      f.client.create({}, items, order, pickup, {
        courier_company_id: 2,
        amount: 50,
      }),
    /Reconcile that reference before retrying/
  )
  assert.equal(
    f.calls.filter((c) => c.url === "/orders/create/adhoc").length,
    1
  )
  assert.ok(!f.calls.some((c) => c.url === "/courier/assign/awb"))
})

test("read-only reconciliation then native reuse never creates a second order or schedules pickup", async (t) => {
  const f = setup(t),
    binding = {
      order_id: 100,
      shipment_id: 42,
      merchant_reference: "order_fixture-1794263026",
    },
    quote = { courier_company_id: 2, amount: 50 }
  const prepared = await f.client.prepareFulfillment(
    {},
    items,
    order,
    pickup,
    quote
  )
  const remote = remoteFixture(prepared.orderData, binding)
  f.setExisting(remote)
  const review = await f.client.reviewExistingFulfillment(
    binding,
    {},
    items,
    order,
    pickup,
    quote
  )
  assert.equal(review.ready, true, review.issues.join(","))
  assert.ok(
    !f.calls.some(
      (c) => c.url === "/orders/create/adhoc" || c.url === "/courier/assign/awb"
    )
  )
  const result = await f.client.create(
    {},
    items,
    order,
    pickup,
    quote,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { ...binding, review_digest: review.digest }
  )
  assert.equal(result.order_id, 100)
  assert.equal(result.shipment_id, 42)
  assert.ok(
    !f.calls.some(
      (c) =>
        c.url === "/orders/create/adhoc" || c.url === "/courier/generate/pickup"
    )
  )
  assert.equal(f.calls.filter((c) => c.url === "/courier/assign/awb").length, 1)
})
test("existing matching AWB is reused and a changed existing order never falls back to create", async (t) => {
  const f = setup(t),
    binding = {
      order_id: 100,
      shipment_id: 42,
      merchant_reference: "order_fixture-1794263026",
    },
    quote = { courier_company_id: 2, amount: 50 }
  const prepared = await f.client.prepareFulfillment(
    {},
    items,
    order,
    pickup,
    quote
  )
  const remote = remoteFixture(prepared.orderData, binding)
  remote.shipments.awb = "EXISTING"
  remote.shipments.courier_company_id = 2
  f.setExisting(remote)
  const review = await f.client.reviewExistingFulfillment(
    binding,
    {},
    items,
    order,
    pickup,
    quote
  )
  assert.equal(review.ready, true)
  const result = await f.client.create(
    {},
    items,
    order,
    pickup,
    quote,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { ...binding, review_digest: review.digest }
  )
  assert.equal(result.awb, "EXISTING")
  remote.total = 1
  await assert.rejects(
    () =>
      f.client.create(
        {},
        items,
        order,
        pickup,
        quote,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { ...binding, review_digest: review.digest }
      ),
    /amount.total/
  )
  assert.ok(
    !f.calls.some((c) =>
      [
        "/orders/create/adhoc",
        "/courier/assign/awb",
        "/orders/cancel",
        "/courier/generate/pickup",
      ].includes(c.url)
    )
  )
})

test("AWB business rejection retains its draft and never cancels or schedules pickup", async (t) => {
  const f = setup(t)
  f.setAwbResponse({
    awb_assign_status: 0,
    response: { message: "Courier unavailable" },
  })
  await assert.rejects(
    () =>
      f.client.create({}, items, order, pickup, {
        courier_company_id: 2,
        amount: 50,
      }),
    /retained/
  )
  assert.ok(
    !f.calls.some((c) =>
      ["/orders/cancel", "/courier/generate/pickup"].includes(c.url)
    )
  )
})
test("numeric-string AWB success keeps the selected courier without pickup", async (t) => {
  const f = setup(t)
  f.setAwbResponse({
    awb_assign_status: "1",
    response: { data: { awb_code: "FIXTURE", courier_company_id: 2 } },
  })
  const result: any = await f.client.create({}, items, order, pickup, {
    courier_company_id: 2,
    amount: 50,
  })
  assert.equal(result.awb, "FIXTURE")
  assert.ok(!f.calls.some((c) => c.url === "/courier/generate/pickup"))
})

test("merchant alternatives include all eligible couriers only in the purchased service mode", async (t) => {
  const f = setup(t)
  f.setRows([
    { ...courier, courier_company_id: 2, is_surface: true },
    { ...courier, courier_company_id: 3, is_surface: true, rate: 80 },
    { ...courier, courier_company_id: 4, is_surface: false },
    { ...courier, courier_company_id: 5, is_surface: undefined },
    { ...courier, courier_company_id: 6, is_surface: true, rate: 0 },
  ])
  const rows = await f.client.fulfillmentCouriers(
    {
      pickup_postcode: "110077",
      delivery_postcode: "110077",
      weight: 0.52,
      cod: 0,
    },
    "surface"
  )
  assert.deepEqual(
    rows.map((r) => r.courier_company_id),
    [2, 3]
  )
  assert.ok(
    !f.calls.some(
      (c) => c.url === "/orders/create/adhoc" || c.url === "/courier/assign/awb"
    )
  )
})

test("existing AWB guard follows authoritative pagination and never trusts a negative prefix search", async (t) => {
  const f = setup(t)
  f.setOrderPages([
    {
      data: [{ id: 99, channel_order_id: "unrelated" }],
      meta: { pagination: { total_pages: 2 } },
    },
    {
      data: [{ id: 100, channel_order_id: "order_fixture-1794263026" }],
      meta: { pagination: { total_pages: 2 } },
    },
  ])
  f.setExisting({ id: 100, shipments: { id: 42, awb: "EXISTING" } })
  assert.deepEqual(
    await f.client.existingFulfillmentAttempts(
      "order_fixture",
      "medusa_fixture"
    ),
    [{ order_id: 100, shipment_id: 42, awb_present: true }]
  )
  const reads = f.calls.filter((c) => c.url === "/orders")
  assert.equal(reads.length, 2)
  assert.ok(reads.every((c) => c.params.search === undefined))
  assert.ok(
    !f.calls.some(
      (c) => c.url === "/orders/create/adhoc" || c.url === "/courier/assign/awb"
    )
  )
})

test("fulfillment sends the same minimum dimensions for serviceability and the prepared order without altering the parcel", async (t) => {
  const f = setup(t),
    parcel = Object.freeze({
      weight_grams: 520,
      length_mm: 1,
      width_mm: 2,
      height_mm: 3,
    })
  const result = await f.client.prepareFulfillment(
    {},
    items,
    order,
    pickup,
    { courier_company_id: 2, amount: 50 },
    parcel
  )
  assert.deepEqual(
    [
      result.orderData.length,
      result.orderData.breadth,
      result.orderData.height,
    ],
    [0.5, 0.5, 0.5]
  )
  const params = f.calls.find(
    (c) => c.url === "/courier/serviceability/"
  ).params
  assert.deepEqual(
    [params.length, params.breadth, params.height],
    [0.5, 0.5, 0.5]
  )
  assert.deepEqual(parcel, {
    weight_grams: 520,
    length_mm: 1,
    width_mm: 2,
    height_mm: 3,
  })
  assert.ok(
    !f.calls.some(
      (c) => c.url === "/orders/create/adhoc" || c.url === "/courier/assign/awb"
    )
  )
})
