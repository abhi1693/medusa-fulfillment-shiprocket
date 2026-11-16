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
