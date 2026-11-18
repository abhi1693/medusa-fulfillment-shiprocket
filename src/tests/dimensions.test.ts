import test from "node:test"
import assert from "node:assert/strict"
import { getLineItemDimensions } from "../providers/shiprocket/utils/dimensions"
test("product measurements are inherited per field without repeating values on the variant", () => {
  assert.deepEqual(
    getLineItemDimensions({
      weight: null,
      length: 500,
      width: null,
      product: { weight: 5220, length: 600, width: 400, height: 200 },
    }),
    { weightGrams: 5220, weightKg: 5.22, length: 500, width: 400, height: 200 }
  )
})
test("verified server measurements bridge native fulfillment's omitted parent-product projection", () => {
  assert.deepEqual(
    getLineItemDimensions(
      { product: { id: "product" } },
      { weight_grams: 5220, length_mm: 600, width_mm: 400, height_mm: 200 }
    ),
    { weightGrams: 5220, weightKg: 5.22, length: 600, width: 400, height: 200 }
  )
})
test("explicit invalid variant values remain invalid rather than silently falling back", () => {
  assert.equal(
    getLineItemDimensions({ weight: 0, product: { weight: 5220 } }).weightGrams,
    0
  )
  assert.equal(
    getLineItemDimensions({ weight: -1, product: { weight: 5220 } })
      .weightGrams,
    -1
  )
})
