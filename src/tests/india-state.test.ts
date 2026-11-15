import test from "node:test"
import assert from "node:assert/strict"
import { indiaStateName } from "../shared/india-state"
test("carrier transport uses names for known native province codes without guessing unknown states", () => {
  for (const code of ["in-hr", "IN-HR", "hr", " HR "])
    assert.equal(indiaStateName(code), "Haryana")
  assert.equal(indiaStateName("in-tn"), "Tamil Nadu")
  assert.equal(indiaStateName("  Tamil   Nadu "), "Tamil Nadu")
  for (const value of ["unknown", "constructor", "in-zz"])
    assert.equal(indiaStateName(value), value)
  assert.equal(indiaStateName(null), "")
})
