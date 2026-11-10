import test from "node:test"
import assert from "node:assert/strict"
import Provider from "../providers/shiprocket/service"
import {
  courierPolicy,
  selectCourier,
} from "../providers/shiprocket/utils/courier-policy"
import { signCourierQuote } from "../shared/courier-quote"
import { pickupScope } from "../shared/pickup-mapping"
import { shiprocketApiUrl } from "../providers/shiprocket/client/config"
test("valid displayed quote is applied without any carrier/provider quote lookup and does not extend expiry", async (t) => {
  const previous = process.env.JWT_SECRET
  process.env.JWT_SECRET = "fixture-signing-secret-at-least-32-characters"
  t.after(() => {
    if (previous === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = previous
  })
  const options = {
    mode: "test" as const,
    email: "fixture@example.test",
    password: "fixture",
    courier_selection: "lowest_price",
  }
  const policy = courierPolicy(options)
  const context = {
    id: "cart_fixture",
    currency_code: "inr",
    from_location: {
      id: "loc_fixture",
      name: "Fixture warehouse",
      address: { postal_code: "122001" },
    },
    shipping_address: { postal_code: "110077", country_code: "in" },
    items: [{ id: "item_fixture", quantity: 1 }],
    shiprocket_quote_option_id: "so_fixture",
    shiprocket_quote_account_scope: pickupScope(
      shiprocketApiUrl("test"),
      options.email
    ),
  }
  const params = {
    pickup_postcode: "122001",
    delivery_postcode: "110077",
    weight: 0.52,
    cod: 0,
  }
  const quote = signCourierQuote(
    selectCourier(
      [
        {
          courier_company_id: 8,
          courier_name: "Fixture",
          rate: 50,
          is_surface: false,
          estimated_delivery_days: "2",
        },
      ],
      policy
    ),
    params,
    context
  )
  const logger: any = {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  }
  const service: any = new Provider({ logger }, options)
  service.client = {
    quote: async () => {
      throw Error("Redundant carrier recheck")
    },
    quotes: async () => {
      throw Error("Redundant carrier recheck")
    },
  }
  const option = { shiprocket_option_id: "so_fixture" }
  const result = await service.calculatePrice(
    option,
    { shiprocket_quote: quote },
    context
  )
  assert.equal(result.calculated_amount, 50)
  assert.equal(result.shiprocket_quote.quote_token, quote.quote_token)
  assert.equal(result.shiprocket_quote.expires_at, quote.expires_at)
  const validated = await service.validateFulfillmentData(
    option,
    { shiprocket_quote: { ...quote, courier_name: "untrusted display text" } },
    context
  )
  assert.equal(validated.shiprocket_quote.courier_name, "Fixture")
  assert.equal(validated.shiprocket_quote.origin_location_id, "loc_fixture")
})
