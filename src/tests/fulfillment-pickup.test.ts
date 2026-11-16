import test from "node:test"
import assert from "node:assert/strict"
import {
  prepareFulfillmentPickup,
  readFulfillmentPickup,
  readFulfillmentContext,
} from "../shared/fulfillment-pickup"
import { pickupScope } from "../shared/pickup-mapping"
import { shiprocketApiUrl } from "../providers/shiprocket/client/config"
import { signCourierQuote } from "../shared/courier-quote"
import {
  quotePackedUnits,
  remainingPackedUnits,
} from "../shared/packed-unit-plan"
import { courierPolicy } from "../providers/shiprocket/utils/courier-policy"
process.env.JWT_SECRET = "fixture-fulfillment-signing-secret-at-least-32"
process.env.SHIPROCKET_EMAIL = "api@example.test"
process.env.SHIPROCKET_PASSWORD = "fixture-password"
process.env.SHIPROCKET_MODE = "test"
const location = {
  id: "loc",
  name: "Warehouse",
  address: {
    company: "Example",
    phone: "9876543210",
    address_1: "123 Example Road",
    city: "Delhi",
    province: "Delhi",
    postal_code: "110001",
    country_code: "in",
  },
  metadata: { shiprocket_pickup_id: "123" },
  fulfillment_providers: [{ id: "shiprocket_shiprocket" }],
}
const quote = {
  origin_location_id: "loc",
  quote_token: "saved-courier-33",
  courier_company_id: 33,
}
function fixture(changes: any = {}) {
  const source = changes.location ?? location
  const mapping = {
    scope: pickupScope(shiprocketApiUrl(), process.env.SHIPROCKET_EMAIL!),
    external_id: "123",
  }
  const queries: any[] = []
  const query = {
    graph: async (input: any) => {
      queries.push(input)
      return {
        data:
          input.entity === "order"
            ? [
                {
                  id: "order",
                  currency_code: "inr",
                  metadata: changes.metadata ?? {},
                  fulfillments: changes.fulfillments ?? [],
                  items: changes.items ?? [],
                  shipping_methods: changes.methods ?? [
                    {
                      shipping_option_id: "option",
                      total: 400,
                      tax_total: 0,
                      discount_total: 0,
                      data: { shiprocket_quote: changes.quote ?? quote },
                    },
                  ],
                },
              ]
            : input.entity === "shipping_option"
              ? (changes.options ?? [
                  {
                    id: "option",
                    provider_id: changes.provider ?? "shiprocket_shiprocket",
                    service_zone: {
                      fulfillment_set: { location: { id: "loc" } },
                    },
                  },
                ])
              : source
                ? [source]
                : [],
      }
    },
  }
  return {
    container: {
      resolve: (key: string) => {
        if (key === "query") return query
        throw Error("Unexpected service: " + key)
      },
    },
    queries,
    mapping,
  }
}
const lookup = async (id: string) => ({
  id,
  pickup_location: "real-nickname",
  pin_code: "110001",
})
const prepare = (container: any, order: string, input: any) =>
  prepareFulfillmentPickup(container, order, input, lookup)
test("existing order without snapshot resolves current account/location/revision mapping without changing its courier", async () => {
  const f = fixture()
  const token = await prepare(f.container, "order", {})
  const pickup = readFulfillmentPickup(
    token,
    "order",
    "option",
    "loc",
    f.mapping.scope,
    quote
  )
  assert.equal(pickup.nickname, "real-nickname")
  assert.equal(pickup.external_id, "123")
  assert.equal(quote.courier_company_id, 33)
})
test("actual fulfillment warehouse may not silently replace the quoted origin", async () => {
  await assert.rejects(
    prepare(fixture().container, "order", {
      location_id: "other",
    }),
    /warehouse must match/
  )
})
test("customer quote and request fields cannot authorize merchant carrier spending", async () => {
  const untrusted = {
    courier_company_id: 33,
    service: "surface",
    amount: 1000,
  }
  const paid = { ...quote, merchant_courier_selection: untrusted }
  const f = fixture({ quote: paid })
  const token = await prepare(f.container, "order", {
    additional_data: { merchant_courier_selection: untrusted },
  })
  const context = readFulfillmentContext(
    token,
    "order",
    "option",
    "loc",
    f.mapping.scope,
    paid
  )
  assert.equal(context.merchant_courier_selection, undefined)
})
test("missing metadata, wrong connection and detached provider fail clearly", async () => {
  for (const metadata of [
    {},
    { shiprocket_pickup_id: "invalid" },
    { shiprocket_pickup_id: "123", shiprocket_pickup_scope: "other" },
  ]) {
    await assert.rejects(
      prepare(
        fixture({ location: { ...location, metadata } }).container,
        "order",
        {}
      ),
      /pickup|connection/
    )
  }
  await assert.rejects(
    prepare(
      fixture({ location: { ...location, fulfillment_providers: [] } })
        .container,
      "order",
      {}
    ),
    /not attached/
  )
})
test("explicit existing ID mapping does not require native address to match remote staging address", async () => {
  const f = fixture({ location: { ...location, address: {} } })
  assert.ok(await prepare(f.container, "order", {}))
})
test("manual fulfillment is unaffected", async () => {
  assert.equal(
    await prepare(
      fixture({ provider: "manual_manual" }).container,
      "order",
      {}
    ),
    undefined
  )
})
test("preflight cannot be forged, reused for another order/warehouse/option/quote or replayed after expiry", async () => {
  const f = fixture()
  const token = (await prepare(f.container, "order", {}))!
  const read = (
    value: any,
    order = "order",
    option = "option",
    loc = "loc",
    q = quote
  ) => readFulfillmentPickup(value, order, option, loc, f.mapping.scope, q)
  for (const args of [
    [undefined],
    [token + "x"],
    [token, "other"],
    [token, "order", "other"],
    [token, "order", "option", "other"],
    [token, "order", "option", "loc", { ...quote, quote_token: "different" }],
  ])
    assert.throws(() => read(...(args as [any])), /preflight/)
  const now = Date.now
  Date.now = () => now() + 61000
  try {
    assert.throws(() => read(token), /preflight/)
  } finally {
    Date.now = now
  }
})

test("fulfillment signed context projects every parent-product measurement and preserves per-field variant overrides", async () => {
  const items = [
    {
      id: "line",
      variant: {
        weight: undefined,
        length: 500,
        width: null,
        height: undefined,
        product: { weight: 5220, length: 600, width: 400, height: 200 },
      },
    },
  ]
  const f = fixture({ items })
  const token = await prepare(f.container, "order", {})
  const context = readFulfillmentContext(
    token,
    "order",
    "option",
    "loc",
    f.mapping.scope,
    quote
  )
  assert.deepEqual(context.item_measurements.line, {
    weight_grams: 5220,
    length_mm: 500,
    width_mm: 400,
    height_mm: 200,
  })
  const orderQuery = f.queries.find((input) => input.entity === "order")
  for (const field of ["weight", "length", "width", "height"])
    assert(orderQuery.fields.includes("items.variant.product." + field))
})

test("native charged shipping and measured parcel are signed server facts rather than client overrides", async () => {
  const parcel = {
    weight_grams: 5220,
    length_mm: 500,
    width_mm: 300,
    height_mm: 200,
    items: [{ id: "line", quantity: 2 }],
  }
  const f = fixture({
    metadata: { shiprocket_parcels: { option: parcel } },
    fulfillments: [
      {
        id: "first",
        shipping_option_id: "option",
        data: {
          shiprocket_carrier_cost: { amount: 100, currency_code: "inr" },
        },
      },
    ],
  })
  const token = await prepareFulfillmentPickup(
    f.container,
    "order",
    { items: parcel.items },
    lookup
  )
  const context = readFulfillmentContext(
    token,
    "order",
    "option",
    "loc",
    f.mapping.scope,
    quote
  )
  assert.deepEqual(context.parcel, parcel)
  assert.equal(context.shipping_charge?.total, 400)
  assert.equal(context.shipping_charge?.previous_fulfillments.length, 1)
  await assert.rejects(
    prepareFulfillmentPickup(
      f.container,
      "order",
      { items: [{ id: "line", quantity: 1 }] },
      lookup
    ),
    /different items/
  )
})

test("two methods for the same profile cannot silently share an unknown item pool", async () => {
  const option = {
    id: "option",
    provider_id: "shiprocket_shiprocket",
    shipping_profile_id: "profile",
    service_zone: { fulfillment_set: { location: { id: "loc" } } },
  }
  const f = fixture({
    options: [option, { ...option, id: "second" }],
    methods: [
      { shipping_option_id: "option", data: { shiprocket_quote: quote } },
      { shipping_option_id: "second", data: { shiprocket_quote: quote } },
    ],
  })
  await assert.rejects(
    prepareFulfillmentPickup(f.container, "order", {}, lookup),
    /per-method item allocation/
  )
})

test("explicit merchant courier can change service in signed fulfillment context without changing the paid quote", async () => {
  const serviceQuote = { ...quote, service: "surface" }
  const override = {
    scope: pickupScope(shiprocketApiUrl(), process.env.SHIPROCKET_EMAIL!),
    location_id: "loc",
    service: "air",
    courier_company_id: 51,
    courier_name: "Merchant choice",
    amount: 55,
  }
  const f = fixture({
    quote: serviceQuote,
    metadata: { shiprocket_fulfillment_couriers: { option: override } },
  })
  const token = await prepare(f.container, "order", {})
  const context = readFulfillmentContext(
    token,
    "order",
    "option",
    "loc",
    override.scope,
    serviceQuote
  )
  assert.equal(context.courier?.courier_company_id, 51)
  assert.equal(context.courier?.service, "air")
  assert.equal(context.courier?.amount, 55)
  assert.deepEqual(context.merchant_courier_selection, {
    courier_company_id: 51,
    service: "air",
    amount: 55,
  })
  assert.equal(serviceQuote.service, "surface")
  assert.equal(serviceQuote.courier_company_id, 33)
  assert.equal(serviceQuote.quote_token, "saved-courier-33")
  for (const invalid of [
    { ...override, service: "unknown" },
    { ...override, location_id: "other" },
    { ...override, scope: "other" },
    { ...override, courier_company_id: 0 },
  ]) {
    const f = fixture({
      quote: serviceQuote,
      metadata: { shiprocket_fulfillment_couriers: { option: invalid } },
    })
    await assert.rejects(
      () => prepare(f.container, "order", {}),
      /merchant courier selection/
    )
  }
})

test("package overrides follow only their remaining stable unit and may change surface to air", async () => {
  const item = {
    id: "line",
    variant_id: "variant",
    unit_price: 100,
    quantity: 2,
    requires_shipping: true,
    detail: { fulfilled_quantity: 0 },
    variant: { weight: 500, length: 100, width: 80, height: 20 },
  }
  const context = {
    id: "cart",
    currency_code: "inr",
    items: [item],
    from_location: {
      id: "loc",
      address: { country_code: "in", postal_code: "110001" },
    },
    shipping_address: { country_code: "in", postal_code: "110002" },
    shiprocket_quote_option_id: "option",
    shiprocket_quote_account_scope: "account",
  }
  const result = await quotePackedUnits(context, async () => [
    {
      courier_company_id: 33,
      courier_name: "Paid surface",
      amount: 50,
      service: "surface",
      rating: 4,
      estimated_delivery_days: null,
      estimated_delivery_date: null,
      realtime_tracking: true,
      pod: "instant",
      call_before_delivery: true,
      policy: courierPolicy(),
      relaxed_preferences: [],
      quoted_at: new Date().toISOString(),
    },
  ])
  const paid = signCourierQuote(result.choices[0], result.params, context)
  const original = structuredClone(paid)
  const order = {
    items: [item],
    shipping_methods: [
      { shipping_option_id: "option", data: { shiprocket_quote: paid } },
    ],
  }
  const jobs = remainingPackedUnits(order)
  const override = {
    scope: pickupScope(shiprocketApiUrl(), process.env.SHIPROCKET_EMAIL!),
    shipping_option_id: "option",
    location_id: "loc",
    service: "air",
    courier_company_id: 60,
    courier_name: "Merchant air",
    amount: 65,
  }
  const f = fixture({
    items: [item],
    quote: paid,
    metadata: {
      shiprocket_package_couriers: { [jobs[1].id]: override },
      // Legacy per-method selection must not leak into packages.
      shiprocket_fulfillment_couriers: {
        option: { ...override, courier_company_id: 99 },
      },
    },
  })
  const read = async (packageId?: string) => {
    const token = await prepare(f.container, "order", {
      items: [{ id: "line", quantity: 1 }],
      package_id: packageId,
    })
    return readFulfillmentContext(
      token,
      "order",
      "option",
      "loc",
      override.scope,
      paid
    )
  }
  const first = await read()
  assert.equal(first.package_id, jobs[0].id)
  assert.equal(first.courier?.courier_company_id, 33)
  assert.equal(first.courier?.service, "surface")
  assert.equal(first.merchant_courier_selection, undefined)
  const future = await read(jobs[1].id)
  assert.equal(future.package_id, jobs[1].id)
  assert.equal(future.courier?.courier_company_id, 60)
  assert.equal(future.courier?.service, "air")
  assert.equal(future.courier?.amount, 65)
  assert.deepEqual(future.merchant_courier_selection, {
    courier_company_id: 60,
    service: "air",
    amount: 65,
  })
  assert.equal(future.financials?.lines[0].fulfilled_quantity, 0)
  assert.deepEqual(paid, original)
  item.detail.fulfilled_quantity = 1
  const next = await read()
  assert.equal(next.package_id, jobs[1].id)
  assert.equal(next.courier?.courier_company_id, 60)
  await assert.rejects(() => read(jobs[0].id), /package is no longer available/)
  for (const invalid of [
    { ...override, shipping_option_id: "other" },
    { ...override, location_id: "other" },
    { ...override, scope: "other" },
  ]) {
    const bad = fixture({
      items: [item],
      quote: paid,
      metadata: { shiprocket_package_couriers: { [jobs[1].id]: invalid } },
    })
    await assert.rejects(
      () =>
        prepare(bad.container, "order", {
          items: [{ id: "line", quantity: 1 }],
        }),
      /merchant courier selection/
    )
  }
  await assert.rejects(
    () => prepare(fixture().container, "order", { package_id: jobs[0].id }),
    /package is no longer available/
  )
})
