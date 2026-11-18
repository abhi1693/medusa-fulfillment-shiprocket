import test from "node:test"
import assert from "node:assert/strict"
import {
  validatePackedParcel,
  packedParcelForItems,
  parcelItemsKey,
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

test("legacy parcel revision tolerates absent measurements", () => {
  assert.equal(parcelRevision(null), "none")
})
