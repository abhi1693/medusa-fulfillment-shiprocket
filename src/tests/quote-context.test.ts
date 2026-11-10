import test from "node:test"
import assert from "node:assert/strict"
import {
  shiprocketItemMeasurements,
  shiprocketQuote,
} from "../providers/shiprocket/utils/quote"
const base = () => ({
  currency_code: "inr",
  from_location: { address: { country_code: "in", postal_code: "122001" } },
  shipping_address: { country_code: "in", postal_code: "122006" },
})
test("product dimensions omitted by native pricing projection reach the quote through hook context", () => {
  const items = [
    {
      id: "item_fixture",
      quantity: 1,
      variant: { weight: null, length: null, width: null, height: null },
      product: { weight: 520, length: 30, width: 141.8, height: 127.6 },
    },
  ]
  const nativeItems = [
    {
      id: "item_fixture",
      quantity: 1,
      variant: { weight: null, length: null, width: null, height: null },
      product: { weight: 520 },
    },
  ]
  assert.deepEqual(shiprocketQuote({ ...base(), items: nativeItems }), {
    pickup_postcode: "122001",
    delivery_postcode: "122006",
    weight: 0.52,
    cod: 0,
  })
  assert.deepEqual(
    shiprocketQuote({
      ...base(),
      items: nativeItems,
      shiprocket_item_measurements: shiprocketItemMeasurements(items),
    }),
    {
      pickup_postcode: "122001",
      delivery_postcode: "122006",
      weight: 0.52,
      length: 3,
      breadth: 14.180000000000001,
      height: 12.76,
      cod: 0,
    }
  )
})
test("variant overrides and product inheritance apply per field without changing stored data", () => {
  const item = {
    id: "item_fixture",
    variant: { weight: 600, length: null, width: 120, height: null },
    product: { weight: 520, length: 30, width: 141.8, height: 127.6 },
  }
  assert.deepEqual(shiprocketItemMeasurements([item]).item_fixture, {
    weight_grams: 600,
    length_mm: 30,
    width_mm: 120,
    height_mm: 127.6,
  })
  assert.equal(item.variant.length, null)
})
test("weight-based estimates omit unknown package dimensions", () => {
  const item = {
    id: "item_fixture",
    quantity: 1,
    variant: {},
    product: { weight: 520 },
  }
  const map = shiprocketItemMeasurements([item])
  assert.deepEqual(
    shiprocketQuote({
      ...base(),
      items: [item],
      shiprocket_item_measurements: map,
    }),
    {
      pickup_postcode: "122001",
      delivery_postcode: "122006",
      weight: 0.52,
      cod: 0,
    }
  )
  assert.deepEqual(
    shiprocketQuote({
      ...base(),
      items: [{ ...item, quantity: 2 }],
      shiprocket_item_measurements: map,
    }),
    {
      pickup_postcode: "122001",
      delivery_postcode: "122006",
      weight: 1.04,
      cod: 0,
    }
  )
})
test("profile-filtered cart items use their own measurements rather than another item's parcel", () => {
  const map = shiprocketItemMeasurements([
    {
      id: "item_a",
      product: { weight: 520, length: 30, width: 140, height: 120 },
    },
    {
      id: "item_b",
      product: { weight: 1000, length: 200, width: 150, height: 100 },
    },
  ])
  assert.equal(
    shiprocketQuote({
      ...base(),
      items: [{ id: "item_b", quantity: 1 }],
      shiprocket_item_measurements: map,
    }).weight,
    1
  )
})

test("multi-item estimates total actual declared weights and quantities without fabricating a carton", () => {
  const items = [
    {
      id: "gateway",
      quantity: 1,
      product: { weight: 520, length: 30, width: 141.8, height: 127.6 },
    },
    {
      id: "router",
      quantity: 1,
      product: { weight: 4700, length: 285.6, width: 442.4, height: 43.7 },
    },
  ]
  assert.deepEqual(shiprocketQuote({ ...base(), items }), {
    pickup_postcode: "122001",
    delivery_postcode: "122006",
    weight: 5.22,
    cod: 0,
  })
  assert.equal(
    shiprocketQuote({
      ...base(),
      items: [items[0], { ...items[1], quantity: 2 }],
    }).weight,
    9.92
  )
  const measured = shiprocketQuote({
    ...base(),
    items,
    shiprocket_parcel: {
      weight_grams: 6000,
      length_mm: 500,
      width_mm: 300,
      height_mm: 200,
    },
  })
  assert.deepEqual(measured, {
    pickup_postcode: "122001",
    delivery_postcode: "122006",
    weight: 6,
    length: 50,
    breadth: 30,
    height: 20,
    cod: 0,
  })
})
test("missing weights and invalid quantities fail without fabricated default values", () => {
  for (const weight of [null, undefined, 0, -1, "invalid", Infinity])
    assert.throws(
      () =>
        shiprocketQuote({
          ...base(),
          items: [{ quantity: 1, product: { weight } }],
        }),
      /item weight/
    )
  for (const quantity of [0, -1, 1.5, Infinity])
    assert.throws(
      () =>
        shiprocketQuote({
          ...base(),
          items: [{ quantity, product: { weight: 520 } }],
        }),
      /quantity/
    )
  assert.throws(
    () => shiprocketQuote({ ...base(), items: [] }),
    /shippable item/
  )
})

test("nullable generated cart graph entries do not invent measurement records", () => {
  const map = shiprocketItemMeasurements([
    null,
    undefined,
    { id: "item_one", product: { weight: 520 } },
  ])
  assert.deepEqual(Object.keys(map), ["item_one"])
  assert.equal(map.item_one.weight_grams, 520)
})
