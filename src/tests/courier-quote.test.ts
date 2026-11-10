import test from "node:test"
import assert from "node:assert/strict"
import { signCourierQuote, verifyCourierQuote } from "../shared/courier-quote"
import { selectCourier } from "../providers/shiprocket/utils/courier-policy"
const policy = {
  selection: "lowest_price" as const,
  require_real_time_tracking: false,
  pod: "any" as const,
  require_call_before_delivery: false,
}
const params = {
  pickup_postcode: "122001",
  delivery_postcode: "110077",
  weight: 1,
  cod: 0,
}
const context = () => ({
  id: "cart_fixture",
  shiprocket_quote_option_id: "so_fixture",
  shiprocket_quote_account_scope: "fixture_test_account",
  currency_code: "inr",
  from_location: { id: "sloc_fixture", address: { postal_code: "122001" } },
  shipping_address: { postal_code: "110077", country_code: "in" },
  items: [{ id: "item_one", quantity: 1 }],
})
function setup(t: any) {
  const previous = process.env.JWT_SECRET
  process.env.JWT_SECRET = "fixture-signing-secret-at-least-32-characters"
  t.after(() => {
    if (previous === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = previous
  })
}
test("quote signature binds courier, amount, cart, warehouse, policy and request with five minute expiry", (t) => {
  setup(t)
  const quote = selectCourier(
    [
      {
        courier_company_id: 43,
        courier_name: "Fixture",
        rate: 50,
        is_surface: false,
      },
    ],
    policy
  )
  const signed = signCourierQuote(quote, params, context())
  assert.deepEqual(verifyCourierQuote(signed, context(), policy), params)
  for (const modified of [
    { ...signed, amount: 1 },
    { ...signed, service: "surface" },
    { ...signed, courier_company_id: 99 },
    { ...signed, quote_token: signed.quote_token + "x" },
  ])
    assert.throws(
      () => verifyCourierQuote(modified, context(), policy),
      /expired or changed/
    )
  for (const modified of [
    { ...context(), id: "cart_other" },
    { ...context(), shiprocket_quote_option_id: "so_other_profile" },
    { ...context(), shiprocket_quote_account_scope: "other_live_account" },
    { ...context(), items: [{ id: "item_one", quantity: 2 }] },
    {
      ...context(),
      from_location: { id: "sloc_other", address: { postal_code: "122001" } },
    },
    {
      ...context(),
      shipping_address: { postal_code: "110001", country_code: "in" },
    },
  ])
    assert.throws(
      () => verifyCourierQuote(signed, modified, policy),
      /expired or changed/
    )
  assert.throws(
    () =>
      verifyCourierQuote(signed, context(), {
        ...policy,
        require_real_time_tracking: true,
      }),
    /expired or changed/
  )
  const now = Date.now
  Date.now = () => now() + 6 * 60 * 1000
  try {
    assert.throws(
      () => verifyCourierQuote(signed, context(), policy),
      /expired or changed/
    )
  } finally {
    Date.now = now
  }
})
