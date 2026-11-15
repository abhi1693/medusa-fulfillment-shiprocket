import assert from "node:assert/strict"
import test from "node:test"
import { parcelWeightSource } from "../shared/parcel-weight"

test("accepts exact shipment weight with matching original or absent legacy original", () => {
  for (const original of [undefined, 0.163, "0.1630", 0.16300000000000003])
    assert.equal(
      parcelWeightSource("0.163", original, 0.163),
      "shipment_exact"
    )
  assert.equal(parcelWeightSource(1, "1e0", "1.000"), "shipment_exact")
  assert.equal(
    parcelWeightSource(0.16300000000000003, undefined, 0.163),
    "shipment_exact"
  )
})

test("corroborates the observed 0.163 kg declaration and 0.16 kg shipment projection", () => {
  assert.equal(
    parcelWeightSource(0.16, "0.163", 0.163),
    "original_two_decimal_projection"
  )
  assert.equal(
    parcelWeightSource("0.1600", 0.163, "1.63e-1"),
    "original_two_decimal_projection"
  )
  assert.equal(
    parcelWeightSource(0.16000000000000003, 0.16300000000000003, 0.163),
    "original_two_decimal_projection"
  )
})

test("rounds the original decimal value canonically at hundredth-kilogram boundaries", () => {
  for (const [original, projected] of [
    [0.16499999999999998, 0.16],
    [0.165, 0.17],
    [0.1699, 0.17],
    [1.005, 1.01],
    [10.075, 10.08],
    [100.005, 100.01],
  ])
    assert.equal(
      parcelWeightSource(projected, original, original),
      "original_two_decimal_projection",
      String(original)
    )
})

test("does not substitute a nearby, truncated, rounded-up or differently scaled weight", () => {
  for (const [shipment, original, expected] of [
    [0.161, 0.163, 0.163],
    [0.17, 0.163, 0.163],
    [0.16, 0.165, 0.165],
    [1, 1.005, 1.005],
    [0.16, 0.1634, 0.163],
    [0.16, 0.163001, 0.163],
    [163, 0.163, 0.163],
    [0.01, 1e-7, 1e-7],
    [0, 0.001, 0.001],
  ])
    assert.equal(parcelWeightSource(shipment, original, expected), null)
})

test("rejects missing or invalid original evidence for a rounded shipment", () => {
  for (const original of [
    undefined,
    null,
    "",
    " ",
    0,
    -0.163,
    NaN,
    Infinity,
    true,
    [],
    {},
    "0.163kg",
  ])
    assert.equal(parcelWeightSource(0.16, original, 0.163), null)
})

test("rejects present contradictory originals even when shipment weight is exact", () => {
  for (const original of [
    null,
    "",
    0,
    0.16,
    "0.164",
    false,
    [0.163],
    { value: 0.163 },
    NaN,
    Infinity,
  ])
    assert.equal(parcelWeightSource(0.163, original, 0.163), null)
})

test("the legacy float allowance stays below one milligram for shipment and original comparisons", () => {
  assert.equal(
    parcelWeightSource(0.1630009, undefined, 0.163),
    "shipment_exact"
  )
  assert.equal(
    parcelWeightSource(0.163, 0.1630009, 0.163),
    "shipment_exact"
  )
  for (const changed of [0.163001, 0.162999, 0.1630011, 0.1629989]) {
    assert.equal(parcelWeightSource(changed, undefined, 0.163), null)
    assert.equal(parcelWeightSource(0.163, changed, 0.163), null)
  }
})

test("rejects invalid shipment or expected weights rather than coercing nonweights", () => {
  for (const value of [
    undefined,
    null,
    "",
    " ",
    0,
    -1,
    NaN,
    Infinity,
    true,
    false,
    [1],
    { value: 1 },
    "0x1",
    "0b1",
    "1kg",
  ]) {
    assert.equal(parcelWeightSource(value, undefined, 1), null)
    assert.equal(parcelWeightSource(1, undefined, value), null)
  }
})
