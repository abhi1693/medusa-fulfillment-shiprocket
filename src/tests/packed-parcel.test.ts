import test from "node:test"
import assert from "node:assert/strict"
import {
  validatePackedParcel,
  packedParcelForItems,
  parcelItemsKey,
  selectedItemWeight,
  parcelRevision,
} from "../shared/packed-parcel"
const parcel = {
  weight_grams: 5220,
  length_mm: 500,
  width_mm: 300,
  height_mm: 200,
  items: [
    { id: "a", quantity: 1 },
    { id: "b", quantity: 1 },
  ],
}
test("measured parcel requires finite positive values and exact item quantities", () => {
  assert.equal(validatePackedParcel(parcel), parcel)
  const metadata = { shiprocket_parcels: { option: parcel } }
  assert.equal(
    packedParcelForItems(metadata, "option", [...parcel.items].reverse()),
    parcel
  )
  assert.throws(
    () => packedParcelForItems(metadata, "option", [{ id: "a", quantity: 1 }]),
    /different items/
  )
  for (const bad of [0, -1, NaN, Infinity, undefined])
    assert.throws(() => validatePackedParcel({ ...parcel, weight_grams: bad }))
  assert.throws(() =>
    parcelItemsKey([
      { id: "a", quantity: 1 },
      { id: "a", quantity: 1 },
    ])
  )
  assert.equal(packedParcelForItems({}, "option", parcel.items), undefined)
})

test("weight prefill sums selected quantities using per-item variant/product fallback without invented defaults", () => {
  const items = [
    { id: "a", variant: { weight: null, product: { weight: 520 } } },
    { id: "b", variant: { weight: 4700, product: { weight: 9999 } } },
  ]
  assert.equal(selectedItemWeight(items, { a: 1, b: 1 }).weight_grams, 5220)
  assert.equal(selectedItemWeight(items, { a: 2, b: 0 }).weight_grams, 1040)
  assert.equal(
    selectedItemWeight(
      [{ id: "a", variant: { weight: 0, product: { weight: 520 } } }],
      { a: 1 }
    ).weight_grams,
    undefined
  )
  assert.deepEqual(selectedItemWeight([], { a: 1 }).missing_ids, ["a"])
  assert.equal(parcelRevision(null), "none")
})
