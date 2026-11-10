import test from "node:test"
import assert from "node:assert/strict"
import {
  prepareFulfillmentPickup,
  readFulfillmentPickup,
  readFulfillmentContext,
} from "../shared/fulfillment-pickup"
import { pickupScope } from "../shared/pickup-mapping"
import { shiprocketApiUrl } from "../providers/shiprocket/client/config"
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

test("explicit merchant courier preserves purchased service and is bound into signed fulfillment context", async () => {
  const serviceQuote = { ...quote, service: "surface" }
  const override = {
    scope: pickupScope(shiprocketApiUrl(), process.env.SHIPROCKET_EMAIL!),
    location_id: "loc",
    service: "surface",
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
  for (const invalid of [
    { ...override, service: "air" },
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
