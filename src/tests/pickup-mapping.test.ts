import test from "node:test"
import assert from "node:assert/strict"
import {
  metadataPickupId,
  pickupRows,
  resolveMetadataPickup,
  requirePickupSnapshot,
  shiprocketCheckoutData,
} from "../shared/pickup-mapping"
test("metadata requires an existing numeric ID and respects optional account scope", () => {
  assert.equal(metadataPickupId({ shiprocket_pickup_id: 123 }), "123")
  for (const value of [null, 0, -1, "abc", 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => metadataPickupId({ shiprocket_pickup_id: value }))
  assert.throws(
    () =>
      metadataPickupId(
        { shiprocket_pickup_id: "123", shiprocket_pickup_scope: "old" },
        "new"
      ),
    /ACCOUNT_CHANGED/
  )
})
test("remote ID is exact; source addresses are not synchronized or compared", async () => {
  const p = await resolveMetadataPickup(
    "loc",
    { shiprocket_pickup_id: "123" },
    "scope",
    async (id) => ({ id, pickup_location: "remote", pin_code: 110001 })
  )
  assert.equal(p.external_id, "123")
  assert.equal(p.postcode, "110001")
  assert.equal(requirePickupSnapshot(p, "loc", "scope"), p)
  assert.throws(() => requirePickupSnapshot(p, "other", "scope"))
  assert.throws(() => requirePickupSnapshot(p, "loc", "other"))
  await assert.rejects(
    resolveMetadataPickup(
      "loc",
      { shiprocket_pickup_id: "123" },
      "scope",
      async () => ({ id: 456 })
    ),
    /NOT_FOUND/
  )
})
test("supports unfiltered and ID-filtered API shapes", () => {
  const row = { id: 123 }
  for (const body of [
    [row],
    { data: [row] },
    { data: { shipping_address: [row] } },
    { data: row },
    row,
  ])
    assert.deepEqual(pickupRows(body), [row])
  assert.throws(() => pickupRows({}))
})
test("checkout does not copy legacy or client-supplied pickup snapshots", () => {
  assert.deepEqual(
    shiprocketCheckoutData(
      { shiprocket_pickup: { old: true } },
      { shiprocket_pickup: { forged: true }, shiprocket_quote: {}, other: 1 }
    ),
    { other: 1 }
  )
})
