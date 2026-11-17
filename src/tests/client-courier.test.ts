import { POST as checkAwbRoute } from "../api/admin/shiprocket/fulfillments/[id]/awb/sync/route"
import { POST as retryAwbRoute } from "../api/admin/shiprocket/fulfillments/[id]/awb/retry/route"
import { remoteFixture } from "./fixtures/existing-order"
import {
  financialSnapshot,
  stableFulfillmentReference,
} from "../shared/order-money"
import test from "node:test"
import assert from "node:assert/strict"
import axios from "axios"
import ShiprocketClient from "../providers/shiprocket/client"
import { resetShiprocketManager } from "../providers/shiprocket/client/manager"

async function pendingRouteFixture(t: any) {
  const env = { ...process.env }
  Object.assign(process.env, {
    SHIPROCKET_MODE: "test",
    SHIPROCKET_EMAIL: "fixture@example.test",
    SHIPROCKET_PASSWORD: "fixture",
    SHIPROCKET_ASSIGNMENT_SECRET: assignmentKey,
  })
  t.after(() => {
    for (const key of [
      "SHIPROCKET_MODE",
      "SHIPROCKET_EMAIL",
      "SHIPROCKET_PASSWORD",
      "SHIPROCKET_ASSIGNMENT_SECRET",
    ]) {
      if (env[key] === undefined) delete process.env[key]
      else process.env[key] = env[key]
    }
  })
  const f = setup(t, {
    auto_assign_awb: false,
    assignment_secret: assignmentKey,
  })
  const quote = { courier_company_id: 2, amount: 50 }
  const prepared = await f.client.prepareFulfillment(
    {},
    items,
    order,
    pickup,
    quote
  )
  const draft = await f.client.create(
    { id: "ful_manual" },
    items,
    order,
    pickup,
    quote
  )
  const remote = remoteFixture(prepared.orderData, {
    order_id: 100,
    shipment_id: 42,
    merchant_reference: prepared.orderData.order_id,
  })
  f.setExisting(remote)
  let saved: any = {
    id: "ful_manual",
    provider_id: "shiprocket_shiprocket",
    data: { ...draft, shiprocket_awb_pending: true },
    labels: [],
  }
  const scope = {
    resolve: (key: string) =>
      key === "logger"
        ? { info() {}, warn() {}, error() {}, debug() {} }
        : key === "locking"
          ? { execute: async (_key: string, fn: any) => fn() }
          : {
              retrieveFulfillment: async () => saved,
              updateFulfillment: async (_id: string, input: any) => {
                saved = { ...saved, ...input }
                return saved
              },
            },
  }
  const call = async (route: any, body?: any) => {
    const res: any = {
      statusCode: 200,
      body: undefined,
      status(value: number) {
        this.statusCode = value
        return this
      },
      json(value: any) {
        this.body = value
        return this
      },
    }
    await route(
      {
        scope,
        params: { id: "ful_manual" },
        body,
        auth_context: { actor_id: "user_fixture" },
      },
      res
    )
    return res
  }
  return { ...f, remote, call, saved: () => saved }
}

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
  let awbFailure: any
  let createFailure: any
  let orderPages: any[] = []
  let existing: any
  let orderReads = 0
  let onRead: ((n: number, remote: any) => void) | undefined
  axios.defaults.adapter = async (config: any) => {
    calls.push({
      url: config.url,
      timeout: config.timeout,
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
    } else if (config.url === "/courier/assign/awb") {
      if (awbFailure) throw awbFailure
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
    } else if (config.url === "/orders/cancel") {
      assert.deepEqual(JSON.parse(config.data).ids, [100])
      existing.status = "CANCELED"
      existing.shipments.status = "CANCELED"
      data = { status: 200 }
    } else if (config.url === "/orders")
      data = orderPages[Number(config.params.page) - 1]
    else if (config.url === "/orders/show/100") {
      onRead?.(++orderReads, existing)
      data = { data: existing }
    } else if (config.url === "/courier/generate/pickup")
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
    setAwbFailure: (value: any) => (awbFailure = value),
    setAwbResponse: (value: any) => (awbResponse = value),
    setOrderPages: (value: any[]) => (orderPages = value),
    setExisting: (value: any) => (existing = value),
    setOnRead: (value: any) => (onRead = value),
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
    /Fulfill one packed unit/
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

test("rate diagnostics explain cache, rejection, fallback and selection without raw customer data", async (t) => {
  const messages: string[] = []
  const previous = process.env.SHIPROCKET_RATE_DIAGNOSTICS
  delete process.env.SHIPROCKET_RATE_DIAGNOSTICS
  t.after(() => {
    if (previous === undefined) delete process.env.SHIPROCKET_RATE_DIAGNOSTICS
    else process.env.SHIPROCKET_RATE_DIAGNOSTICS = previous
  })
  const f = setup(t, {
    require_real_time_tracking: true,
    preferred_call_before_delivery: true,
    logger: {
      info: (m: string) => messages.push(m),
      warn: () => {},
      debug: () => {},
      error: () => {},
    },
  })
  f.setRows([
    {
      ...courier,
      courier_company_id: 1,
      rate: 10,
      realtime_tracking: "Not Available",
      secret: "DO_NOT_LOG",
    },
    { ...courier, call_before_delivery: "Not Available" },
    { ...courier, courier_company_id: 3, is_surface: true, rate: 80 },
  ])
  const input = {
    pickup_postcode: "110077",
    delivery_postcode: "122001",
    weight: 1,
    cod: 0,
  }
  const choices = await f.client.quotes(input)
  assert.deepEqual(
    choices.map((q) => q.courier_company_id),
    [2, 3]
  )
  await f.client.quote(input)
  const decision = JSON.parse(
    messages
      .find((m) => m.startsWith("Shiprocket rate decision "))!
      .slice("Shiprocket rate decision ".length)
  )
  assert.equal(decision.candidates[0].status, "rejected")
  assert.deepEqual(decision.candidates[0].reasons, [
    "real_time_tracking_required",
  ])
  assert.deepEqual(decision.candidates[1].relaxed_preferences, [
    "call_before_delivery",
  ])
  assert.equal(decision.candidates[2].status, "selected")
  assert.ok(messages.some((m) => m.includes("cache_hit")))
  assert.ok(!messages.join("").includes("DO_NOT_LOG"))
  assert.ok(!messages.join("").includes("122001"))
  assert.ok(!messages.join("").includes("110077"))
  const before = messages.length
  process.env.SHIPROCKET_RATE_DIAGNOSTICS = "false"
  await f.client.quotes(input)
  assert.equal(messages.length, before)
})

test("overall quote diagnostics preserve unknown-service eligibility while checkout excludes it", async (t) => {
  const messages: string[] = []
  const f = setup(t, {
    logger: {
      info: (m: string) => messages.push(m),
      warn: () => {},
      debug: () => {},
      error: () => {},
    },
  })
  f.setRows([{ ...courier, is_surface: undefined }])
  await f.client.quote({
    pickup_postcode: "110077",
    delivery_postcode: "122001",
    weight: 1,
    cod: 0,
  })
  const record = JSON.parse(
    messages
      .find((m) => m.startsWith("Shiprocket rate decision "))!
      .slice("Shiprocket rate decision ".length)
  )
  assert.equal(record.candidates[0].status, "selected")
  assert.deepEqual(record.candidates[0].reasons, [])
})

test("read-only cancellation verification does not revalidate an unavailable previous courier or change pickup", async (t) => {
  const f = setup(t)
  f.setRows([])
  const financials = financialSnapshot(order, order.shipping_methods[0], [
    { id: "item_fixture", quantity: 1 },
  ])
  const reference = stableFulfillmentReference(order.id, "option", financials)
  f.setOrderPages([
    {
      data: [{ id: 100, channel_order_id: reference }],
      meta: { pagination: { total_pages: 1 } },
    },
  ])
  f.setExisting({
    id: 100,
    channel_order_id: reference,
    status: "CANCELED",
    status_code: 5,
    shipments: { id: 42, awb: "" },
  })
  const result = await f.client.inspectCancelledFulfillment(
    [
      { shipping_option_id: "option" },
      items,
      order,
      pickup,
      { courier_company_id: 2, amount: 50 },
      undefined,
      undefined,
      () => {
        throw Error("Previous courier/rate must not be checked")
      },
      financials,
    ],
    [],
    reference
  )
  assert.equal(result.base_reference, reference)
  assert.deepEqual(result.cancelled_order_ids, [100])
  assert(
    f.calls.every((call) =>
      ["/auth/login", "/orders", "/orders/show/100"].includes(call.url)
    )
  )
})

test("read-only cancellation verification requires a trusted native financial allocation before carrier access", async (t) => {
  const f = setup(t)
  await assert.rejects(
    f.client.inspectCancelledFulfillment(
      [{ shipping_option_id: "option" }, items, order, pickup],
      [],
      "medusa_saved"
    ),
    /financial allocation/
  )
  assert.equal(f.calls.length, 0)
})

test("all API calls use the shared 60 second default", async (t) => {
  const f = setup(t)
  await f.client.create({}, items, order, pickup, {
    courier_company_id: 2,
    amount: 50,
  })
  assert.equal(
    f.calls.find((c) => c.url === "/courier/assign/awb").timeout,
    60000
  )
  assert.equal(
    f.calls.find((c) => c.url === "/orders/create/adhoc").timeout,
    60000
  )
})
for (const status of [0, "0"])
  test(`explicit AWB rejection ${JSON.stringify(status)} cancels only its verified draft and allows same-order retry`, async (t) => {
    const f = setup(t),
      quote = { courier_company_id: 2, amount: 50 }
    const prepared = await f.client.prepareFulfillment(
      {},
      items,
      order,
      pickup,
      quote
    )
    const binding = {
      order_id: 100,
      shipment_id: 42,
      merchant_reference: prepared.orderData.order_id,
    }
    f.setExisting(remoteFixture(prepared.orderData, binding))
    f.setAwbResponse({
      awb_assign_status: status,
      message: "assignment failed",
    })
    await assert.rejects(
      () => f.client.create({}, items, order, pickup, quote),
      /cancelled and cancellation confirmed/
    )
    assert.equal(f.calls.filter((c) => c.url === "/orders/cancel").length, 1)
    assert.equal(
      f.calls.filter((c) => c.url === "/orders/create/adhoc").length,
      1
    )
    assert.equal(
      f.calls.filter((c) => c.url === "/courier/assign/awb").length,
      1
    )
    f.setOrderPages([
      {
        data: [{ id: 100, channel_order_id: binding.merchant_reference }],
        meta: { pagination: { total_pages: 1 } },
      },
    ])
    const next = await f.client.recoverFailedFulfillment(
      [{}, items, order, pickup, quote],
      [],
      undefined,
      { reference_hint: binding.merchant_reference }
    )
    assert.notEqual(next.reference, binding.merchant_reference)
    assert.ok(next.reference.endsWith("_r1"))
    assert.equal(next.resume, undefined)
  })
test("a 504 assignment with a verified late AWB completes the same fulfillment", async (t) => {
  const f = setup(t),
    quote = { courier_company_id: 2, amount: 50 }
  const prepared = await f.client.prepareFulfillment(
    {},
    items,
    order,
    pickup,
    quote
  )
  const remote = remoteFixture(prepared.orderData, {
    order_id: 100,
    shipment_id: 42,
    merchant_reference: prepared.orderData.order_id,
  })
  remote.shipments.awb = "ASSIGNED_WHILE_TIMED_OUT"
  remote.shipments.courier_company_id = 2
  f.setExisting(remote)
  f.setAwbFailure(
    Object.assign(new Error("Gateway timeout"), {
      response: { status: 504, data: {} },
    })
  )
  remote.status = "READY TO SHIP"
  remote.status_code = 3
  remote.shipments.status = 1
  // The first read is still an unbooked draft; the next read exposes the assigned AWB.
  f.setOnRead((n: number, value: any) => {
    value.status = n === 1 ? "NEW" : "READY TO SHIP"
    value.shipments.status = n === 1 ? "PENDING" : 1
    value.shipments.awb = n === 1 ? "" : "ASSIGNED_WHILE_TIMED_OUT"
  })
  const result = await f.client.create({}, items, order, pickup, quote)
  assert.equal(result.awb, "ASSIGNED_WHILE_TIMED_OUT")
  assert.equal((result as any).shiprocket_awb_recovered, true)
  assert.equal(f.calls.filter((c) => c.url === "/courier/assign/awb").length, 1)
  assert.equal(f.calls.filter((c) => c.url === "/orders/cancel").length, 0)
  assert.equal(
    f.calls.filter((c) => c.url === "/orders/create/adhoc").length,
    1
  )
})

for (const failure of [
  "timeout",
  "network",
  "http500",
  "http502",
  "http503",
  "http504",
  "missing-status",
  "success-without-awb",
  "rejection-timeout",
  "rejection-rmk-timeout",
  "rejection-string-timeout",
  "rejection-action-timeout",
  "rejection-status408",
  "rejection-status425",
  "rejection-status429",
  "rejection-status500",
  "rejection-status504",
]) {
  test(`uncertain ${failure} retains its exact draft after bounded reads and never cancels`, async (t) => {
    const f = setup(t)
    const quote = { courier_company_id: 2, amount: 50 }
    const prepared = await f.client.prepareFulfillment(
      {},
      items,
      order,
      pickup,
      quote
    )
    f.setExisting(
      remoteFixture(prepared.orderData, {
        order_id: 100,
        shipment_id: 42,
        merchant_reference: prepared.orderData.order_id,
      })
    )
    if (failure === "missing-status") f.setAwbResponse({ response: {} })
    else if (failure === "success-without-awb")
      f.setAwbResponse({ awb_assign_status: 1, response: { data: {} } })
    else if (failure === "rejection-timeout")
      f.setAwbResponse({
        awb_assign_status: 0,
        response: { data: { awb_assign_error: "Carrier gateway timed out" } },
      })
    else if (failure === "rejection-rmk-timeout")
      f.setAwbResponse({
        awb_assign_status: 0,
        response: { data: { rmk: "Carrier request timed out" } },
      })
    else if (failure === "rejection-string-timeout")
      f.setAwbResponse({
        awb_assign_status: "0",
        response: { data: "cURL error 28: upstream timeout" },
      })
    else if (failure === "rejection-action-timeout")
      f.setAwbResponse({
        awb_assign_status: 0,
        response: {
          action_required:
            "Carrier gateway timed out. Check assignment before retrying.",
        },
      })
    else if (failure.startsWith("rejection-status"))
      f.setAwbResponse({
        awb_assign_status: 0,
        status_code: failure.slice(16),
        message: "Carrier request was not completed",
      })
    else
      f.setAwbFailure(
        Object.assign(
          Error(failure),
          failure.startsWith("http")
            ? { response: { status: Number(failure.slice(4)), data: {} } }
            : { code: failure === "timeout" ? "ECONNABORTED" : "ECONNRESET" }
        )
      )
    await assert.rejects(
      () => f.client.create({}, items, order, pickup, quote),
      (error: any) => {
        assert.match(
          error.message,
          /did not confirm AWB assignment for order 100, shipment 42/
        )
        assert.ok(error.message.includes(prepared.orderData.order_id))
        assert.match(error.message, /assignment may still complete/)
        assert.match(error.message, /no order was cancelled or replaced/)
        return true
      }
    )
    assert.equal(
      f.calls.filter((c) => c.url === "/orders/show/100").length,
      [
        "timeout",
        "network",
        "http500",
        "http502",
        "http503",
        "http504",
      ].includes(failure)
        ? 3
        : 1
    )
    assert.equal(f.calls.filter((c) => c.url === "/orders/cancel").length, 0)
    assert.equal(
      f.calls.filter((c) => c.url === "/orders/create/adhoc").length,
      1
    )
    assert.equal(
      f.calls.filter((c) => c.url === "/courier/assign/awb").length,
      1
    )
  })
}

test("a late AWB with mismatched courier is not reused or cancelled after an uncertain response", async (t) => {
  const f = setup(t)
  const quote = { courier_company_id: 2, amount: 50 }
  const prepared = await f.client.prepareFulfillment(
    {},
    items,
    order,
    pickup,
    quote
  )
  const remote = remoteFixture(prepared.orderData, {
    order_id: 100,
    shipment_id: 42,
    merchant_reference: prepared.orderData.order_id,
  })
  remote.shipments.awb = "OTHER_COURIER_AWB"
  remote.shipments.courier_company_id = 99
  f.setExisting(remote)
  f.setAwbFailure(
    Object.assign(Error("Gateway timeout"), {
      response: { status: 504, data: {} },
    })
  )
  await assert.rejects(
    () => f.client.create({}, items, order, pickup, quote),
    /assignment may still complete/
  )
  assert.equal(f.calls.filter((c) => c.url === "/orders/cancel").length, 0)
})

test("an unavailable verification read cannot turn a 504 into permission to cancel", async (t) => {
  const f = setup(t)
  f.setAwbFailure(
    Object.assign(Error("Gateway timeout"), {
      response: { status: 504, data: {} },
    })
  )
  await assert.rejects(
    () =>
      f.client.create({}, items, order, pickup, {
        courier_company_id: 2,
        amount: 50,
      }),
    /did not confirm AWB assignment for order 100, shipment 42/
  )
  assert.equal(f.calls.filter((c) => c.url === "/orders/cancel").length, 0)
  assert.equal(
    f.calls.filter((c) => c.url === "/orders/create/adhoc").length,
    1
  )
})

test("carrier rejection survives confirmed cancellation and logs only redacted diagnostic fields", async (t) => {
  const logs: string[] = []
  const f = setup(t, {
    logger: {
      info: (s: string) => logs.push(s),
      warn: (s: string) => logs.push(s),
      debug: () => {},
      error: (s: string) => logs.push(s),
    },
  })
  const quote = { courier_company_id: 2, amount: 50 }
  const prepared = await f.client.prepareFulfillment(
    {},
    items,
    order,
    pickup,
    quote
  )
  f.setExisting(
    remoteFixture(prepared.orderData, {
      order_id: 100,
      shipment_id: 42,
      merchant_reference: prepared.orderData.order_id,
    })
  )
  f.setAwbResponse({
    awb_assign_status: 0,
    response: {
      data: {
        awb_assign_error:
          "Carrier SR-AWB-42 cannot allocate waybill for Fixture Merchant at Fixture address, fixture@example.test, 9876543210; password=fixture",
      },
      action_required: "Contact the carrier integration team",
    },
  })
  await assert.rejects(
    () => f.client.create({}, items, order, pickup, quote),
    (e: any) => {
      assert.match(e.message, /Carrier SR-AWB-42 cannot allocate waybill/)
      assert.match(e.message, /Contact the carrier integration team/)
      assert.match(e.message, /cancellation confirmed/)
      assert.ok(!e.message.includes("fixture@example.test"))
      assert.ok(!e.message.includes("Fixture address"))
      assert.ok(!e.message.includes("9876543210"))
      return true
    }
  )
  assert.ok(
    logs.some(
      (s) => s.startsWith("Shiprocket AWB result ") && s.includes("SR-AWB-42")
    )
  )
  assert.ok(
    logs.some(
      (s) => s.startsWith("Shiprocket AWB failure ") && s.includes("SR-AWB-42")
    )
  )
  for (const line of logs.filter((s) => s.startsWith("Shiprocket AWB"))) {
    for (const secret of [
      "Fixture Merchant",
      "Fixture address",
      "fixture@example.test",
      "9876543210",
      "password=fixture",
    ])
      assert.ok(!line.includes(secret), secret)
  }
})

test("carrier warehouse remark survives confirmed cancellation without copying its raw response", async (t) => {
  const logs: string[] = []
  const f = setup(t, {
    logger: {
      info: (s: string) => logs.push(s),
      warn: (s: string) => logs.push(s),
      debug: () => {},
      error: (s: string) => logs.push(s),
    },
  })
  const quote = { courier_company_id: 2, amount: 50 }
  const prepared = await f.client.prepareFulfillment(
    {},
    items,
    order,
    pickup,
    quote
  )
  f.setExisting(
    remoteFixture(prepared.orderData, {
      order_id: 100,
      shipment_id: 42,
      merchant_reference: prepared.orderData.order_id,
    })
  )
  const reason = "ClientWarehouse matching query does not exist."
  f.setAwbResponse({
    awb_assign_status: 0,
    response: {
      data: {
        rmk: reason,
        error: true,
        success: false,
        unknown: "must-not-copy-raw-warehouse-payload",
      },
    },
    no_pickup_popup: 0,
    quick_pick: 0,
  })
  await assert.rejects(
    () => f.client.create({}, items, order, pickup, quote),
    (e: any) => {
      assert.ok(e.message.includes(reason))
      assert.match(e.message, /cancellation confirmed/)
      assert.ok(!e.message.includes("must-not-copy-raw-warehouse-payload"))
      return true
    }
  )
  assert.ok(
    logs.some(
      (line) =>
        line.startsWith("Shiprocket AWB result ") && line.includes(reason)
    )
  )
  assert.ok(
    logs.some(
      (line) =>
        line.startsWith("Shiprocket AWB failure ") && line.includes(reason)
    )
  )
  assert.ok(
    !logs.some((line) => line.includes("must-not-copy-raw-warehouse-payload"))
  )
})

test("plain response-data rejection survives confirmed cancellation", async (t) => {
  const f = setup(t)
  const quote = { courier_company_id: 2, amount: 50 }
  const prepared = await f.client.prepareFulfillment(
    {},
    items,
    order,
    pickup,
    quote
  )
  f.setExisting(
    remoteFixture(prepared.orderData, {
      order_id: 100,
      shipment_id: 42,
      merchant_reference: prepared.orderData.order_id,
    })
  )
  f.setAwbResponse({
    awb_assign_status: 0,
    response: { data: "Please contact support team" },
    no_pickup_popup: 0,
    quick_pick: 0,
  })
  await assert.rejects(
    () => f.client.create({}, items, order, pickup, quote),
    (e: any) => {
      assert.match(e.message, /Please contact support team/)
      assert.match(e.message, /cancellation confirmed/)
      return true
    }
  )
})

test("cancellation verification failure preserves the original carrier rejection", async (t) => {
  const f = setup(t)
  f.setAwbResponse({
    awb_assign_status: 0,
    response: {
      data: { awb_assign_error: "Carrier SR-VERIFY-7 rejected allocation" },
    },
  })
  await assert.rejects(
    () =>
      f.client.create({}, items, order, pickup, {
        courier_company_id: 2,
        amount: 50,
      }),
    (e: any) => {
      assert.match(e.message, /Carrier SR-VERIFY-7 rejected allocation/)
      assert.match(e.message, /Cancellation could not be confirmed/)
      return true
    }
  )
  assert.equal(f.calls.filter((c) => c.url === "/orders/cancel").length, 0)
})

test("HTTP AWB rejection body remains visible while preserving its draft without transport credentials", async (t) => {
  const f = setup(t),
    quote = { courier_company_id: 2, amount: 50 }
  const prepared = await f.client.prepareFulfillment(
    {},
    items,
    order,
    pickup,
    quote
  )
  f.setExisting(
    remoteFixture(prepared.orderData, {
      order_id: 100,
      shipment_id: 42,
      merchant_reference: prepared.orderData.order_id,
    })
  )
  f.setAwbFailure(
    Object.assign(new Error("request failed"), {
      response: {
        status: 422,
        data: {
          message: "Carrier service SR-HTTP-422 rejected this request",
          action_required: "Review carrier configuration",
        },
        headers: { authorization: "hidden-response-credential" },
      },
      config: { headers: { authorization: "hidden-request-credential" } },
    })
  )
  await assert.rejects(
    () => f.client.create({}, items, order, pickup, quote),
    (e: any) => {
      assert.match(e.message, /Carrier service SR-HTTP-422/)
      assert.match(e.message, /Review carrier configuration/)
      assert.match(e.message, /no order was cancelled or replaced/)
      assert.ok(!e.message.includes("hidden-"))
      return true
    }
  )
  assert.equal(f.calls.filter((c) => c.url === "/orders/cancel").length, 0)
})

test("existing-only resume rejection retains its carrier reason without cancelling", async (t) => {
  const f = setup(t),
    quote = { courier_company_id: 2, amount: 50 }
  const prepared = await f.client.prepareFulfillment(
    {},
    items,
    order,
    pickup,
    quote
  )
  const binding = {
    order_id: 100,
    shipment_id: 42,
    merchant_reference: prepared.orderData.order_id,
  }
  f.setExisting(remoteFixture(prepared.orderData, binding))
  const review = await f.client.reviewExistingFulfillment(
    binding,
    {},
    items,
    order,
    pickup,
    quote
  )
  f.setAwbResponse({
    awb_assign_status: 0,
    response: {
      data: { awb_assign_error: "Carrier SR-RESUME-9 refused assignment" },
    },
  })
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
    /Carrier SR-RESUME-9/
  )
  assert.ok(
    !f.calls.some((c) =>
      ["/orders/cancel", "/orders/create/adhoc"].includes(c.url)
    )
  )
})

const assignmentKey = "fixture-assignment-secret-at-least-32-characters"
test("manual fulfillment creates a bound draft without AWB or pickup, then assignment is explicit and idempotent", async (t) => {
  const f = setup(t, {
    auto_assign_awb: false,
    assignment_secret: assignmentKey,
  })
  const quote = { courier_company_id: 2, amount: 50 }
  const prepared = await f.client.prepareFulfillment(
    {},
    items,
    order,
    pickup,
    quote
  )
  const draft = await f.client.create(
    { id: "ful_manual" },
    items,
    order,
    pickup,
    quote
  )
  assert.equal(draft.shiprocket_awb_state, "pending")
  assert.ok(draft.shiprocket_deferred_awb)
  assert.ok(
    !draft.shiprocket_deferred_awb.includes(order.shipping_address.first_name)
  )
  assert.equal(f.calls.filter((c) => c.url === "/courier/assign/awb").length, 0)
  const remote = remoteFixture(prepared.orderData, {
    order_id: 100,
    shipment_id: 42,
    merchant_reference: prepared.orderData.order_id,
  })
  f.setExisting(remote)
  let writes = 0
  const assigned = await f.client.assignDeferredAwb(draft, "ful_manual", {
    pending: false,
    beforeAssign: async () => {
      writes++
    },
  })
  assert.equal(assigned.awb, "FIXTURE")
  assert.equal(writes, 1)
  remote.status = "READY TO SHIP"
  remote.shipments.awb = "FIXTURE"
  remote.shipments.courier_company_id = 2
  assert.equal(
    (
      await f.client.assignDeferredAwb(draft, "ful_manual", {
        pending: true,
        beforeAssign: async () => {
          throw Error("Must not write")
        },
      })
    ).awb,
    "FIXTURE"
  )
  assert.equal(f.calls.filter((c) => c.url === "/courier/assign/awb").length, 1)
  assert.ok(
    !f.calls.some(
      (c) => c.url === "/courier/generate/pickup" || c.url === "/orders/cancel"
    )
  )
  const before = f.calls.length
  await assert.rejects(
    () =>
      f.client.assignDeferredAwb(draft, "another_fulfillment", {
        pending: false,
        beforeAssign: async () => {},
      }),
    /could not be verified/
  )
  assert.equal(f.calls.length, before)
})
test("manual AWB assignment recovers 504 within the same action without replaying POST", async (t) => {
  const f = setup(t, {
    auto_assign_awb: false,
    assignment_secret: assignmentKey,
  })
  const quote = { courier_company_id: 2, amount: 50 }
  const prepared = await f.client.prepareFulfillment(
    {},
    items,
    order,
    pickup,
    quote
  )
  const draft = await f.client.create(
    { id: "ful_manual" },
    items,
    order,
    pickup,
    quote
  )
  const remote = remoteFixture(prepared.orderData, {
    order_id: 100,
    shipment_id: 42,
    merchant_reference: prepared.orderData.order_id,
  })
  f.setExisting(remote)
  f.setAwbFailure(
    Object.assign(Error("Gateway timeout"), {
      response: { status: 504, data: {} },
    })
  )
  f.setOnRead((n: number, value: any) => {
    if (n >= 3) {
      value.status = "READY TO SHIP"
      value.shipments.status = 1
      value.shipments.awb = "MANUAL-LATE-AWB"
      value.shipments.courier_company_id = 2
    }
  })
  const assigned = await f.client.assignDeferredAwb(draft, "ful_manual", {
    pending: false,
    beforeAssign: async () => {},
  })
  assert.equal(assigned.awb, "MANUAL-LATE-AWB")
  assert.equal(f.calls.filter((c) => c.url === "/courier/assign/awb").length, 1)
})
test("unresolved manual assignment retains pending state; mismatches and rate changes cannot assign", async (t) => {
  const f = setup(t, {
    auto_assign_awb: false,
    assignment_secret: assignmentKey,
  })
  const quote = { courier_company_id: 2, amount: 50 }
  const prepared = await f.client.prepareFulfillment(
    {},
    items,
    order,
    pickup,
    quote
  )
  const draft = await f.client.create(
    { id: "ful_manual" },
    items,
    order,
    pickup,
    quote
  )
  const remote = remoteFixture(prepared.orderData, {
    order_id: 100,
    shipment_id: 42,
    merchant_reference: prepared.orderData.order_id,
  })
  f.setExisting(remote)
  f.setAwbFailure(
    Object.assign(Error("Gateway timeout"), {
      response: { status: 504, data: {} },
    })
  )
  await assert.rejects(
    () =>
      f.client.assignDeferredAwb(draft, "ful_manual", {
        pending: false,
        beforeAssign: async () => {},
      }),
    (e: any) => e.uncertain === true
  )
  await assert.rejects(
    () =>
      f.client.assignDeferredAwb(draft, "ful_manual", {
        pending: true,
        beforeAssign: async () => {
          throw Error("No replay")
        },
      }),
    /Shiprocket has not confirmed the earlier AWB request/
  )
  assert.equal(f.calls.filter((c) => c.url === "/courier/assign/awb").length, 1)
  remote.status = "CANCELLATION REQUESTED"
  remote.status_code = 18
  await assert.rejects(
    () =>
      f.client.assignDeferredAwb(draft, "ful_manual", {
        pending: false,
        beforeAssign: async () => {},
      }),
    /does not match/
  )
  assert.equal(f.calls.filter((c) => c.url === "/courier/assign/awb").length, 1)
  remote.status = "NEW"
  delete remote.status_code
  f.setRows([{ ...courier, rate: 51 }])
  await assert.rejects(
    () =>
      f.client.assignDeferredAwb(draft, "ful_manual", {
        pending: false,
        beforeAssign: async () => {
          throw Error("No cost escalation")
        },
      }),
    /rate increased/
  )
  assert.equal(f.calls.filter((c) => c.url === "/courier/assign/awb").length, 1)
})

test("manual assignment distinguishes explicit rejection from a nested upstream timeout", async (t) => {
  const f = setup(t, {
    auto_assign_awb: false,
    assignment_secret: assignmentKey,
  })
  const quote = { courier_company_id: 2, amount: 50 }
  const prepared = await f.client.prepareFulfillment(
    {},
    items,
    order,
    pickup,
    quote
  )
  const draft = await f.client.create(
    { id: "ful_manual" },
    items,
    order,
    pickup,
    quote
  )
  f.setExisting(
    remoteFixture(prepared.orderData, {
      order_id: 100,
      shipment_id: 42,
      merchant_reference: prepared.orderData.order_id,
    })
  )
  f.setAwbResponse({
    awb_assign_status: 0,
    response: { data: { awb_assign_error: "Insufficient balance" } },
  })
  await assert.rejects(
    () =>
      f.client.assignDeferredAwb(draft, "ful_manual", {
        pending: false,
        beforeAssign: async () => {},
      }),
    (e: any) => e.uncertain === false && /balance/.test(e.message)
  )
  f.setAwbResponse({
    awb_assign_status: 0,
    response: { data: { awb_assign_error: "Carrier gateway timed out" } },
  })
  await assert.rejects(
    () =>
      f.client.assignDeferredAwb(draft, "ful_manual", {
        pending: false,
        beforeAssign: async () => {},
      }),
    (e: any) => e.uncertain === true
  )
  await assert.rejects(
    () =>
      f.client.assignDeferredAwb(draft, "ful_manual", {
        pending: true,
        beforeAssign: async () => {},
      }),
    /earlier AWB request/
  )
  assert.equal(f.calls.filter((c) => c.url === "/courier/assign/awb").length, 2)
  assert.ok(!f.calls.some((c) => c.url === "/orders/cancel"))
})

test("manual draft preflight requires a native fulfillment identity before carrier calls", async (t) => {
  const f = setup(t, {
    auto_assign_awb: false,
    assignment_secret: assignmentKey,
  })
  await assert.rejects(
    () =>
      f.client.create({}, items, order, pickup, {
        courier_company_id: 2,
        amount: 50,
      }),
    /native fulfillment ID/
  )
  assert.equal(f.calls.length, 0)
})

test("shipment readback offers one confirmed retry and never assigns while checking", async (t) => {
  const f = await pendingRouteFixture(t)
  const checked = await f.call(checkAwbRoute)
  assert.equal(checked.statusCode, 202)
  assert.equal(checked.body.pending, true)
  assert.ok(checked.body.retry_token)
  assert.equal(f.calls.filter((c) => c.url === "/courier/assign/awb").length, 0)
  assert.equal(
    (
      await f.call(retryAwbRoute, {
        retry_token: checked.body.retry_token,
        confirm: false,
      })
    ).statusCode,
    400
  )
  const body = { retry_token: checked.body.retry_token, confirm: true }
  const assigned = await f.call(retryAwbRoute, body)
  assert.equal(assigned.statusCode, 200)
  assert.equal(assigned.body.awb, "FIXTURE")
  assert.equal(f.saved().data.shiprocket_awb_pending, false)
  assert.equal(f.saved().data.shiprocket_awb_check, null)
  assert.equal(f.saved().data.shiprocket_awb_retry.actor_id, "user_fixture")
  assert.equal(f.saved().labels[0].tracking_number, "FIXTURE")
  assert.equal((await f.call(retryAwbRoute, body)).statusCode, 409)
  assert.deepEqual(
    f.calls.filter((c) => c.url === "/courier/assign/awb").map((c) => c.data),
    [{ shipment_id: 42, courier_id: 2 }]
  )
  assert.equal(
    f.calls.filter((c) => c.url === "/orders/create/adhoc").length,
    1
  )
  assert.ok(
    !f.calls.some((c) =>
      ["/orders/cancel", "/courier/generate/pickup"].includes(c.url)
    )
  )
})

test("expired checks cannot retry and a late AWB is adopted before a confirmed retry posts", async (t) => {
  const f = await pendingRouteFixture(t)
  const checked = await f.call(checkAwbRoute)
  f.saved().data.shiprocket_awb_check.checked_at = new Date(
    Date.now() - 300001
  ).toISOString()
  assert.equal(
    (
      await f.call(retryAwbRoute, {
        retry_token: checked.body.retry_token,
        confirm: true,
      })
    ).statusCode,
    409
  )
  const fresh = await f.call(checkAwbRoute)
  let reads = 0
  f.setOnRead((_count, remote) => {
    if (++reads === 2) {
      remote.shipments.awb = "LATE-AWB"
      remote.shipments.status = "AWB ASSIGNED"
      remote.shipments.courier_company_id = 2
      remote.status = "READY TO SHIP"
      remote.status_code = 3
    }
  })
  const result = await f.call(retryAwbRoute, {
    retry_token: fresh.body.retry_token,
    confirm: true,
  })
  assert.equal(result.statusCode, 200, JSON.stringify(result.body))
  assert.equal(result.body.awb, "LATE-AWB")
  assert.equal(f.calls.filter((c) => c.url === "/courier/assign/awb").length, 0)
})

test("a confirmed retry timeout keeps its new pending attempt and consumes the confirmation", async (t) => {
  const f = await pendingRouteFixture(t)
  const checked = await f.call(checkAwbRoute)
  f.setAwbFailure(
    Object.assign(Error("Gateway timeout"), {
      response: { status: 504, data: {} },
    })
  )
  const body = { retry_token: checked.body.retry_token, confirm: true }
  assert.equal((await f.call(retryAwbRoute, body)).statusCode, 409)
  assert.equal(f.saved().data.shiprocket_awb_pending, true)
  assert.equal(f.saved().data.shiprocket_awb_check, null)
  assert.ok(f.saved().data.shiprocket_awb_attempt_id)
  assert.equal((await f.call(retryAwbRoute, body)).statusCode, 409)
  assert.equal(f.calls.filter((c) => c.url === "/courier/assign/awb").length, 1)
})
