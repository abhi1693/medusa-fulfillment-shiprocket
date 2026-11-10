import test from "node:test"
import assert from "node:assert/strict"
import {
  shiprocketParcelDimensions,
  shiprocketQuote,
  shiprocketDimensionCm,
} from "../providers/shiprocket/utils/quote"
const base = {
  currency_code: "inr",
  from_location: { address: { country_code: "in", postal_code: "110075" } },
  shipping_address: { country_code: "in", postal_code: "122006" },
}
test("each outbound dimension floors at 0.5 cm after mm conversion without changing measurements", () => {
  for (const [input, expected] of [
    [[1, 2, 3], { length: 0.5, breadth: 0.5, height: 0.5 }],
    [[5, 5, 5], { length: 0.5, breadth: 0.5, height: 0.5 }],
    [[100, 20, 3], { length: 10, breadth: 2, height: 0.5 }],
    [[5.1, 15, 20], { length: 0.51, breadth: 1.5, height: 2 }],
  ] as const)
    assert.deepEqual(
      shiprocketParcelDimensions(input[0], input[1], input[2]),
      expected
    )
  const parcel = Object.freeze({
    weight_grams: 2350,
    length_mm: 100,
    width_mm: 20,
    height_mm: 3,
  })
  const result = shiprocketQuote({ ...base, shiprocket_parcel: parcel })
  assert.equal(result.weight, 2.35)
  assert.equal(result.height, 0.5)
  assert.equal(parcel.height_mm, 3)
})
test("single-product checkout and explicit measured quotes use the same minimum", () => {
  const result = shiprocketQuote({
    ...base,
    items: [
      {
        id: "item",
        quantity: 1,
        variant: { weight: 2350, length: 1, width: 2, height: 3 },
      },
    ],
  })
  assert.deepEqual(
    [result.length, result.breadth, result.height],
    [0.5, 0.5, 0.5]
  )
  assert.equal(shiprocketDimensionCm(0.3, "height"), 0.5)
  assert.equal(shiprocketDimensionCm(1.25, "height"), 1.25)
  for (const invalid of [undefined, null, 0, -1, NaN, Infinity])
    assert.throws(() => shiprocketParcelDimensions(invalid, 20, 3))
})
