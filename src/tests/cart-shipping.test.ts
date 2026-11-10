import { signCourierQuote } from "../shared/courier-quote"
import {
  courierPolicy,
  selectCourier,
} from "../providers/shiprocket/utils/courier-policy"
import test from "node:test"
import { shiprocketCheckoutData } from "../shared/pickup-mapping"
import assert from "node:assert/strict"
import {
  shiprocketPaymentPriceLocked,
  shiprocketCartFingerprint,
  invalidateShiprocketCartQuotes,
  restoreShiprocketCartQuotes,
  SHIPROCKET_CART_FINGERPRINT,
} from "../shared/cart-shipping"
const cart = () => ({
  id: "cart_fixture",
  currency_code: "inr",
  shipping_address: { country_code: "in", postal_code: "122001" },
  items: [
    { id: "a", quantity: 1 },
    { id: "b", quantity: 2 },
  ],
})
test("fingerprint is order independent and changes with quantities or destination", () => {
  const original = cart()
  assert.equal(
    shiprocketCartFingerprint(original),
    shiprocketCartFingerprint({
      ...original,
      items: [...original.items].reverse(),
    })
  )
  assert.notEqual(
    shiprocketCartFingerprint(original),
    shiprocketCartFingerprint({
      ...original,
      items: [{ id: "a", quantity: 2 }],
    })
  )
  assert.notEqual(
    shiprocketCartFingerprint(original),
    shiprocketCartFingerprint({
      ...original,
      shipping_address: { postal_code: "110077" },
    })
  )
})
test("item mutation invalidates only calculated Shiprocket selections without resolving any carrier service", async (t) => {
  const previous = process.env.JWT_SECRET
  process.env.JWT_SECRET = "fixture-signing-secret-at-least-32-characters"
  t.after(() => {
    if (previous === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = previous
  })
  const source = cart()
  const policy = courierPolicy()
  const quote = signCourierQuote(
    selectCourier(
      [
        {
          courier_company_id: 8,
          courier_name: "Fixture",
          rate: 50,
          is_surface: false,
        },
      ],
      policy
    ),
    {
      pickup_postcode: "122001",
      delivery_postcode: "122001",
      weight: 1,
      cod: 0,
    },
    {
      ...source,
      from_location: { id: "loc_fixture", address: { postal_code: "122001" } },
      shiprocket_quote_option_id: "so_fixture",
      shiprocket_quote_account_scope: "fixture_account",
    }
  )
  const removed: string[][] = [],
    restored: string[][] = []
  const methods = [
    {
      id: "rocket",
      shipping_option_id: "so_fixture",
      data: {
        shiprocket_quote: quote,
        [SHIPROCKET_CART_FINGERPRINT]: shiprocketCartFingerprint(source),
      },
      shipping_option: {
        provider_id: "shiprocket_shiprocket",
        price_type: "calculated",
      },
    },
    {
      id: "manual",
      shipping_option: { provider_id: "manual_manual", price_type: "flat" },
    },
  ]
  const container: any = {
    resolve(key: string) {
      if (key === "query")
        return {
          graph: async () => ({
            data: [{ ...source, shipping_methods: methods }],
          }),
        }
      if (key === "fulfillment")
        return {
          retrieveFulfillmentOptions: async () => [
            {
              shiprocket_policy: policy,
              shiprocket_account_scope: "fixture_account",
            },
          ],
        }
      if (key === "cart")
        return {
          softDeleteShippingMethods: async (ids: string[]) => removed.push(ids),
          restoreShippingMethods: async (ids: string[]) => restored.push(ids),
        }
      throw new Error("Unexpected service resolution: " + key)
    },
  }
  assert.deepEqual(
    await invalidateShiprocketCartQuotes(container, source.id, true),
    []
  )
  assert.deepEqual(await invalidateShiprocketCartQuotes(container, source.id), [
    "rocket",
  ])
  await restoreShiprocketCartQuotes(container, ["rocket"])
  assert.deepEqual(removed, [["rocket"]])
  assert.deepEqual(restored, [["rocket"]])
  source.items.pop()
  assert.deepEqual(
    await invalidateShiprocketCartQuotes(container, source.id, true),
    ["rocket"]
  )
})

test("checkout cannot persist a forged client cart fingerprint", async () => {
  const source = cart()
  const data = shiprocketCheckoutData(
    {},
    { [SHIPROCKET_CART_FINGERPRINT]: "forged" },
    source
  )
  assert.equal(
    data[SHIPROCKET_CART_FINGERPRINT],
    shiprocketCartFingerprint(source)
  )
  assert.deepEqual(
    shiprocketCheckoutData({}, { [SHIPROCKET_CART_FINGERPRINT]: "forged" }),
    {}
  )
})

test("payment price lock requires a live matching payment amount and currency", () => {
  const source = {
    total: 179,
    currency_code: "inr",
    payment_collection: {
      payment_sessions: [
        { status: "pending", amount: 179, currency_code: "inr" },
      ],
    },
  }
  assert.equal(shiprocketPaymentPriceLocked(source), true)
  for (const session of [
    { status: "canceled", amount: 179, currency_code: "inr" },
    { status: "pending", amount: 180, currency_code: "inr" },
    { status: "pending", amount: 179, currency_code: "usd" },
  ])
    assert.equal(
      shiprocketPaymentPriceLocked({
        ...source,
        payment_collection: { payment_sessions: [session] },
      }),
      false
    )
  assert.equal(shiprocketPaymentPriceLocked({}), false)
})

test("an accepted payment charge survives expiry-only refresh but item edits still invalidate it", async () => {
  const source = {
    ...cart(),
    total: 179,
    payment_collection: {
      payment_sessions: [
        { status: "authorized", amount: 179, currency_code: "inr" },
      ],
    },
  }
  const methods = [
    {
      id: "shipping",
      shipping_option_id: "so",
      data: {
        shiprocket_quote: { expires_at: "2020-01-01" },
        [SHIPROCKET_CART_FINGERPRINT]: shiprocketCartFingerprint(source),
      },
      shipping_option: {
        provider_id: "shiprocket_shiprocket",
        price_type: "calculated",
      },
    },
  ]
  const removed: string[][] = []
  const container: any = {
    resolve(key: string) {
      if (key === "query")
        return {
          graph: async () => ({
            data: [{ ...source, shipping_methods: methods }],
          }),
        }
      if (key === "cart")
        return {
          softDeleteShippingMethods: async (ids: string[]) => removed.push(ids),
        }
      throw Error("No carrier/config call expected")
    },
  }
  assert.deepEqual(
    await invalidateShiprocketCartQuotes(container, source.id, true),
    []
  )
  assert.deepEqual(removed, [])
  assert.deepEqual(
    await invalidateShiprocketCartQuotes(container, source.id, false),
    ["shipping"]
  )
  assert.deepEqual(removed, [["shipping"]])
})
