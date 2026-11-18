import test from "node:test"
import assert from "node:assert/strict"
import { errorHandler } from "@medusajs/framework/http"
import {
  packedUnitInputs,
  quotePackedUnits,
  paidPackedUnitPlan,
  selectPackedUnit,
  remainingPackedUnits,
} from "../shared/packed-unit-plan"
import { signCourierQuote, readCourierQuote } from "../shared/courier-quote"
import { shipmentPolicy } from "../shared/shipment-policy"
import {
  courierPolicy,
  type CourierQuote,
} from "../providers/shiprocket/utils/courier-policy"
const item = (id = "line1", quantity = 1) => ({
  id,
  variant_id: id,
  quantity,
  unit_price: 100,
  requires_shipping: true,
  variant: { weight: 680, length: 206, width: 206, height: 46 },
})

test("shipment policy validates defaults and explicit options, ignoring environment", () => {
  assert.equal(shipmentPolicy().multiple_items, "split_shipment")
  assert.equal(
    shipmentPolicy({ multiple_items: "single_shipment" })
      .single_shipment_dimensions,
    "largest_item"
  )
  for (const multiple_items of ["", "single", "split", "unknown"])
    assert.throws(
      () => shipmentPolicy({ multiple_items }),
      /SHIPROCKET_MULTIPLE_ITEMS/
    )
  assert.throws(
    () => shipmentPolicy({ single_shipment_dimensions: "unknown" }),
    /SHIPROCKET_SINGLE_SHIPMENT_DIMENSIONS/
  )
  const old = process.env.SHIPROCKET_MULTIPLE_ITEMS
  try {
    process.env.SHIPROCKET_MULTIPLE_ITEMS = "single_shipment"
    assert.equal(shipmentPolicy().multiple_items, "split_shipment")
    assert.equal(
      shipmentPolicy({ multiple_items: "split_shipment" }).multiple_items,
      "split_shipment"
    )
  } finally {
    if (old === undefined) delete process.env.SHIPROCKET_MULTIPLE_ITEMS
    else process.env.SHIPROCKET_MULTIPLE_ITEMS = old
  }
})

test("missing measurements opt into Shiprocket defaults per field without replacing cable weights or product inheritance", async () => {
  const c = context([item("cable", 3)])
  ;(c.items[0] as any).variant = {
    weight: 50,
    product: { length: 120, width: null, height: null },
  }
  assert.throws(() => packedUnitInputs(c), /Complete the packed/)
  const policy = {
    multiple_items: "single_shipment",
    missing_measurements: "use_defaults",
  }
  const result = await quotePackedUnits(
    { ...c, shiprocket_shipment_policy: policy },
    async () => [quote("surface")]
  )
  assert.deepEqual(
    [
      result.params.weight,
      result.params.length,
      result.params.breadth,
      result.params.height,
    ],
    [0.15, 12, 0.6, 0.6]
  )
  ;(c.items[0] as any).variant = {}
  const fallback = packedUnitInputs({
    ...c,
    shiprocket_shipment_policy: policy,
  })[0]
  assert.deepEqual(fallback.measurements, {
    weight_grams: 500,
    length_mm: 6,
    width_mm: 6,
    height_mm: 6,
  })
  const split = await quotePackedUnits(
    {
      ...c,
      shiprocket_shipment_policy: {
        ...policy,
        multiple_items: "split_shipment",
        default_item_weight_grams: 100,
        default_item_length_mm: 50,
      },
    },
    async () => [quote("surface", 100)]
  )
  assert.equal(split.choices[0].amount, 300)
  assert.equal(split.params.weight, 0.1)
  assert.equal(split.params.length, 5)
  for (const value of [0, -1, NaN, Infinity, "bad", true]) {
    ;(c.items[0] as any).variant = { weight: value }
    assert.throws(
      () => packedUnitInputs({ ...c, shiprocket_shipment_policy: policy }),
      /Complete the packed/
    )
  }
  for (const key of [
    "default_item_length_mm",
    "default_item_width_mm",
    "default_item_height_mm",
  ])
    assert.throws(() => shipmentPolicy({ [key]: 5 }), /greater than 5 mm/)
  for (const value of [0, -1, NaN, Infinity, "bad"])
    assert.throws(
      () => shipmentPolicy({ default_item_weight_grams: value }),
      /greater than zero/
    )
  assert.throws(
    () => shipmentPolicy({ missing_measurements: "unknown" }),
    /SHIPROCKET_MISSING_MEASUREMENTS/
  )
})

test("single shipment quotes one complete largest-volume package with quantity-weighted actual weight", async () => {
  process.env.JWT_SECRET = "test-packed-unit-signing-secret-long-enough"
  const a = item("a", 3),
    b = item("b", 2)
  a.variant = { weight: 100, length: 100, width: 50, height: 10 }
  b.variant = { weight: 500, length: 80, width: 60, height: 20 }
  const c = {
    ...context([a, b]),
    shiprocket_shipment_policy: {
      multiple_items: "single_shipment",
      single_shipment_dimensions: "largest_item",
    },
    shiprocket_item_measurements: {},
  }
  delete (c as any).shiprocket_item_measurements
  const calls: any[] = []
  const result = await quotePackedUnits(c, async (params) => {
    calls.push(params)
    return [quote("surface", 150)]
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(
    [calls[0].weight, calls[0].length, calls[0].breadth, calls[0].height],
    [1.3, 8, 6, 2]
  )
  assert.equal(result.choices[0].amount, 150)
  const signed = signCourierQuote(result.choices[0], result.params, c)
  const plan = paidPackedUnitPlan(signed)!
  const lines = [a, b].map((line) => ({
    ...line,
    detail: { fulfilled_quantity: 0 },
  }))
  const order = {
    items: lines,
    shipping_methods: [
      { shipping_option_id: "option", data: { shiprocket_quote: signed } },
    ],
  }
  const jobs = remainingPackedUnits(order)
  assert.equal(jobs.length, 1)
  assert.deepEqual(jobs[0].items, [
    { id: "a", quantity: 3 },
    { id: "b", quantity: 2 },
  ])
  assert.equal(
    selectPackedUnit(plan, lines, jobs[0].items, "option", jobs[0].id).courier
      .amount,
    150
  )
  assert.throws(
    () => selectPackedUnit(plan, lines, [{ id: "a", quantity: 1 }]),
    /all items/
  )
  assert.throws(
    () => selectPackedUnit(plan, lines, jobs[0].items, "option", "other"),
    /no longer available/
  )
  // Subsequent global policy changes cannot repartition an existing paid plan.
  process.env.SHIPROCKET_MULTIPLE_ITEMS = "split_shipment"
  assert.equal(remainingPackedUnits(order).length, 1)
  delete process.env.SHIPROCKET_MULTIPLE_ITEMS
  lines[0].detail.fulfilled_quantity = 1
  assert.throws(() => remainingPackedUnits(order), /partially fulfilled/)
  assert.throws(
    () => selectPackedUnit(plan, lines, jobs[0].items),
    /already been fulfilled/
  )
  lines[0].detail.fulfilled_quantity = 3
  lines[1].detail.fulfilled_quantity = 2
  assert.equal(remainingPackedUnits(order).length, 0)
  lines[1].quantity = 3
  assert.throws(() => remainingPackedUnits(order), /quantities no longer match/)
})

test("stacked strategy sums heights by quantity and changed policy invalidates unpaid quotes", async () => {
  const c = {
    ...context([item("a", 2), item("b", 1)]),
    shiprocket_shipment_policy: {
      multiple_items: "single_shipment",
      single_shipment_dimensions: "stacked",
    },
  }
  const result = await quotePackedUnits(c, async () => [quote("surface")])
  assert.equal(result.params.height, 13.8)
  assert.equal(result.params.weight, 2.04)
  const signed = signCourierQuote(result.choices[0], result.params, c)
  const verifiedContext = {
    ...c,
    shiprocket_item_measurements: Object.fromEntries(
      c.items.map((i) => [
        i.id,
        { weight_grams: 680, length_mm: 206, width_mm: 206, height_mm: 46 },
      ])
    ),
  }
  assert.equal(
    readCourierQuote(signed, verifiedContext, courierPolicy()).quote.amount,
    signed.amount
  )
  assert.throws(
    () =>
      readCourierQuote(
        signed,
        {
          ...verifiedContext,
          shiprocket_shipment_policy: { multiple_items: "split_shipment" },
        },
        courierPolicy()
      ),
    /expired or changed/
  )
  await assert.rejects(
    () => quotePackedUnits(c, async () => []),
    /No delivery service/
  )
})
const context = (items = [item()]) => ({
  id: "cart_test",
  currency_code: "inr",
  items,
  from_location: {
    id: "office",
    address: { country_code: "in", postal_code: "122001" },
  },
  shipping_address: { country_code: "in", postal_code: "122006" },
  shiprocket_quote_option_id: "option",
  shiprocket_quote_account_scope: "account",
})
const quote = (service: "air" | "surface", amount = 127.72): CourierQuote => ({
  courier_company_id: service === "air" ? 10 : 43,
  courier_name: "Carrier",
  service,
  amount,
  rating: 4,
  estimated_delivery_days: null,
  estimated_delivery_date: null,
  realtime_tracking: true,
  pod: "instant",
  call_before_delivery: true,
  policy: courierPolicy(),
  relaxed_preferences: [],
  quoted_at: new Date().toISOString(),
})
function responseFor(error: unknown) {
  let status = 0
  let body: any
  errorHandler()(
    error,
    { scope: { resolve: () => ({ info() {}, error() {} }) } } as any,
    {
      status(code: number) {
        status = code
        return this
      },
      json(value: any) {
        body = value
      },
    } as any,
    () => {}
  )
  return { status, body }
}
const validationResponse = (message: string) => (error: unknown) => {
  const { status, body } = responseFor(error)
  assert.equal(status, 400)
  assert.equal(body.type, "invalid_data")
  assert.equal(body.message, message)
  return true
}
test("quotes packed dimensions, deduplicates identical geometry and charges every unit", async () => {
  const calls: any[] = []
  const c = context([item("a", 2), item("b")])
  const result = await quotePackedUnits(c, async (p) => {
    calls.push(p)
    return [quote("surface"), quote("air", 200)]
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    pickup_postcode: "122001",
    delivery_postcode: "122006",
    cod: 0,
    weight: 0.68,
    length: 20.6,
    breadth: 20.6,
    height: 4.6,
  })
  assert.deepEqual(
    result.choices.map((q) => q.amount),
    [383.16, 600]
  )
  assert.deepEqual(
    result.choices[0].parcel_plan?.units.map((u) => u.quantity).sort(),
    [1, 2]
  )
})
test("only offers a service available to every package, and rejects no common service", async () => {
  const b = item("b")
  b.variant.weight = 9800
  const c = context([item(), b])
  const result = await quotePackedUnits(c, async (p) =>
    p.weight > 1 ? [quote("surface", 675.48)] : [quote("air"), quote("surface")]
  )
  assert.equal(result.choices.length, 1)
  assert.equal(result.choices[0].amount, 803.2)
  await assert.rejects(
    quotePackedUnits(c, async (p) => [quote(p.weight > 1 ? "air" : "surface")]),
    /No common/
  )
})
test("validates every packed attribute and commercial quantity before requesting rates", () => {
  for (const v of [0, -1, NaN, Infinity]) {
    const c = context()
    c.items[0].variant.height = v
    assert.throws(() => packedUnitInputs(c), /Complete/)
  }
  for (const q of [0, -1, 1.5, 1001])
    assert.throws(() => packedUnitInputs(context([item("a", q)])), /quantity/)
  assert.throws(() => packedUnitInputs(context([])), /At least/)
})
test("signed plan rejects tampering and catalog changes, freezes paid measurements for fulfillment", async () => {
  process.env.JWT_SECRET = "test-packed-unit-signing-secret-long-enough"
  const c = context([item("a", 2)])
  const result = await quotePackedUnits(c, async () => [quote("surface")])
  const signed = signCourierQuote(result.choices[0], result.params, c)
  const verified = readCourierQuote(signed, c, courierPolicy()).quote
  const reduced = {
    ...c,
    items: c.items.map((item) => ({ ...item, variant: { weight: 680 } })),
  }
  assert.equal(
    readCourierQuote(signed, reduced, courierPolicy()).quote.amount,
    signed.amount
  )
  const plan = paidPackedUnitPlan(verified)!
  assert.equal(plan.units[0].quantity, 2)
  const changed = structuredClone(c)
  changed.items[0].variant.weight = 900
  ;(changed as any).shiprocket_item_measurements = {
    a: { weight_grams: 900, length_mm: 206, width_mm: 206, height_mm: 46 },
  }
  assert.throws(
    () => readCourierQuote(signed, changed, courierPolicy()),
    /expired or changed/
  )
  assert.throws(
    () => paidPackedUnitPlan({ ...signed, amount: 1 }),
    /could not be verified/
  )
  const native = [
    { ...item("a", 2), id: "order_line", detail: { fulfilled_quantity: 0 } },
  ]
  native[0].variant.weight = 900
  const first = selectPackedUnit(
    plan,
    native,
    [{ id: "order_line", quantity: 1 }],
    "option"
  )
  assert.equal(first.measurements.weight_grams, 680)
  native[0].detail.fulfilled_quantity = 1
  assert.notEqual(
    selectPackedUnit(
      plan,
      native,
      [{ id: "order_line", quantity: 1 }],
      "option"
    ).id,
    first.id
  )
  const order = {
    items: native,
    shipping_methods: [
      { shipping_option_id: "option", data: { shiprocket_quote: signed } },
    ],
  }
  const remaining = remainingPackedUnits(order)
  assert.equal(remaining.length, 1)
  assert.equal(
    remaining[0].id,
    selectPackedUnit(
      plan,
      native,
      [{ id: "order_line", quantity: 1 }],
      "option"
    ).id
  )
  assert.throws(
    () => selectPackedUnit(plan, native, [{ id: "order_line", quantity: 2 }]),
    /one packed unit/
  )
  native[0].quantity = 3
  assert.throws(() => remainingPackedUnits(order), /quantities/)
})

test("multiple packed units reach the native Admin error response with actionable guidance", async () => {
  const result = await quotePackedUnits(context([item("a", 2)]), async () => [
    quote("surface"),
  ])
  assert.throws(
    () =>
      selectPackedUnit(
        result.choices[0].parcel_plan!,
        [item("a", 2)],
        [{ id: "a", quantity: 2 }]
      ),
    validationResponse("Fulfill one packed unit at a time.")
  )
})

test("catalog package identity is scoped to its remaining line and method while dispatch stays sequential", async () => {
  process.env.JWT_SECRET = "test-packed-unit-signing-secret-long-enough"
  const c = context([item("variant", 3)])
  const result = await quotePackedUnits(c, async () => [quote("surface")])
  const paid = signCourierQuote(result.choices[0], result.params, c)
  const first = {
    ...item("variant", 2),
    id: "a",
    detail: { fulfilled_quantity: 0 },
  }
  const second = {
    ...item("variant", 1),
    id: "b",
    detail: { fulfilled_quantity: 0 },
  }
  const order = {
    items: [first, second],
    shipping_methods: [
      { shipping_option_id: "option", data: { shiprocket_quote: paid } },
    ],
  }
  const plan = paidPackedUnitPlan(paid)!
  const jobs = remainingPackedUnits(order)
  assert.equal(jobs[0].courier_company_id, 43)
  assert.equal(jobs.length, 3)
  const select = (lineId: string, packageId?: string, optionId = "option") =>
    selectPackedUnit(
      plan,
      order.items,
      [{ id: lineId, quantity: 1 }],
      optionId,
      packageId
    )
  assert.equal(select("a").id, jobs[0].id)
  assert.equal(select("a", jobs[1].id).ordinal, 1)
  assert.equal(select("b", jobs[2].id).ordinal, 2)
  assert.equal(first.detail.fulfilled_quantity, 0)
  assert.throws(() => select("a", jobs[2].id), /package is no longer available/)
  assert.throws(() => select("b", jobs[1].id), /package is no longer available/)
  assert.throws(
    () => select("a", jobs[1].id, "other"),
    /package is no longer available/
  )
  assert.throws(() => select("a", "invalid"), /package is no longer available/)
  first.detail.fulfilled_quantity = 1
  assert.equal(select("a").id, jobs[1].id)
  assert.equal(select("b", jobs[2].id).ordinal, 2)
  assert.throws(() => select("a", jobs[0].id), /package is no longer available/)
  first.detail.fulfilled_quantity = 2
  assert.equal(select("b").id, jobs[2].id)
  assert.throws(() => select("a", jobs[2].id), /package is no longer available/)
  second.detail.fulfilled_quantity = 1
  assert.throws(() => select("b", jobs[2].id), /quantities no longer match/)
})

test("unverified or malformed paid plans retain their validation messages at the HTTP boundary", async () => {
  process.env.JWT_SECRET = "test-packed-unit-signing-secret-long-enough"
  assert.throws(
    () => paidPackedUnitPlan({ parcel_plan: { version: 1, units: [] } }),
    validationResponse("The paid package plan could not be verified")
  )
  const c = context()
  const result = await quotePackedUnits(c, async () => [quote("surface")])
  const invalid = signCourierQuote(
    { ...result.choices[0], parcel_plan: { version: 2, units: [] } } as any,
    result.params,
    c
  )
  assert.throws(
    () => paidPackedUnitPlan(invalid),
    validationResponse("The paid package plan is invalid; review this order")
  )
})

test("unexpected exceptions stay internal instead of becoming customer-facing validation messages", () => {
  const unexpected = Error("Internal fixture details must not be exposed")
  const broken = Object.defineProperty(item(), "requires_shipping", {
    get() {
      throw unexpected
    },
  })
  assert.throws(
    () => packedUnitInputs(context([broken])),
    (error) => {
      assert.equal(error, unexpected)
      const { status, body } = responseFor(error)
      assert.equal(status, 500)
      assert.equal(body.type, "unknown_error")
      assert.equal(body.message, "An unknown error occurred.")
      return true
    }
  )
})
