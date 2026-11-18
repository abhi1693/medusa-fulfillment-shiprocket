import test from "node:test"
import assert from "node:assert/strict"
import {
  recoverFulfillmentAttempt,
  retryReference,
} from "../shared/fulfillment-recovery"
import { SHIPROCKET_BUYER_DETAILS_ACCESS_MESSAGE } from "../shared/existing-order"
import {
  remoteFixture,
  sameAddressRemoteFixture,
  shipmentDetailFixture,
} from "./fixtures/existing-order"
const expected = {
  order_id: "medusa_" + "a".repeat(40),
  shipping_customer_name: "Fixture",
  shipping_last_name: "Person",
  shipping_address: "Test Street",
  shipping_address_2: "",
  shipping_city: "Delhi",
  shipping_state: "Delhi",
  shipping_pincode: "110077",
  shipping_country: "in",
  shipping_email: "fixture@example.test",
  shipping_phone: "9876543210",
  billing_customer_name: "Fixture",
  billing_last_name: "Person",
  billing_address: "Test Street",
  billing_address_2: "",
  billing_city: "Delhi",
  billing_state: "Delhi",
  billing_pincode: "110077",
  billing_country: "in",
  billing_email: "fixture@example.test",
  billing_phone: "9876543210",
  sub_total: 100,
  total_discount: 0,
  shipping_charges: 50,
  giftwrap_charges: 0,
  transaction_charges: 0,
  order_items: [
    { sku: "fixture", units: 1, selling_price: 100, discount: 0, tax: 0 },
  ],
  length: 10,
  breadth: 10,
  height: 10,
  weight: 0.5,
}
const input = () => ({
  native_order_id: "order_fixture",
  order_data: structuredClone(expected),
  pickup_id: "123",
  courier_id: 8,
  protected_order_ids: [] as number[],
})
function fixture(count = 1) {
  const remotes = Array.from({ length: count }, (_, i) =>
    remoteFixture(expected, {
      order_id: 100 + i,
      shipment_id: 42 + i,
      merchant_reference: retryReference(expected.order_id, i),
    })
  )
  const calls: { method: string; path: string; body?: any }[] = []
  const api = {
    get: async (path: string) => {
      calls.push({ method: "GET", path })
      if (path === "/orders")
        return {
          data: {
            data: remotes.map((r) => ({
              id: r.id,
              channel_order_id: r.channel_order_id,
            })),
            meta: { pagination: { total_pages: 1 } },
          },
        }
      if (path.startsWith("/shipments/")) {
        const r = remotes.find(
          (r) => String(r.shipments.id) === path.split("/").pop()
        )!
        return {
          data: {
            data: shipmentDetailFixture(expected, {
              order_id: r.id,
              shipment_id: r.shipments.id,
            }),
          },
        }
      }
      const remote = remotes.find((r) => String(r.id) === path.split("/").pop())
      return { data: { data: structuredClone(remote) } }
    },
    post: async (path: string, body: any) => {
      calls.push({ method: "POST", path, body })
      throw Error("Recovery must not perform carrier writes")
    },
  }
  return {
    api,
    remotes,
    calls,
  }
}
test("no old attempt uses the original deterministic reference and never creates in the recovery step", async () => {
  const f = fixture(0),
    result = await recoverFulfillmentAttempt(f.api, input())
  assert.equal(result.reference, expected.order_id)
  assert.equal(result.verified_attempts, 0)
  assert(!f.calls.some((c) => c.method === "POST"))
})
test("an active unbooked draft is preserved until assignment or cancellation is verified", async () => {
  const f = fixture()
  let observed = 0
  await assert.rejects(
    recoverFulfillmentAttempt(f.api, input(), () => observed++),
    /unconfirmed for order 100, shipment 42/
  )
  assert(observed > 0)
  assert.deepEqual(
    f.calls.filter((c) => c.method === "POST").map((c) => c.path),
    []
  )
  assert.equal(f.calls[f.calls.length - 1]?.path, "/orders/show/100")
})
test("retry after lost cancellation response continues from already-cancelled remote history", async () => {
  const f = fixture(2)
  f.remotes[0].status = "CANCELED"
  f.remotes[1].status = "CANCELLED"
  const result = await recoverFulfillmentAttempt(f.api, input())
  assert.equal(result.reference, retryReference(expected.order_id, 2))
  assert.equal(result.verified_attempts, 2)
  assert(!f.calls.some((c) => c.method === "POST"))
})
test("an existing verified AWB is reused rather than cancelled or purchased twice", async () => {
  const f = fixture()
  f.remotes[0].status = "AWB ASSIGNED"
  f.remotes[0].shipments.status = "AWB ASSIGNED"
  f.remotes[0].shipments.awb = "verified_awb"
  f.remotes[0].shipments.courier_company_id = 8
  const result = await recoverFulfillmentAttempt(f.api, input())
  assert.equal(result.resume?.order_id, 100)
  assert.match(result.resume?.review_digest || "", /^[a-f0-9]{64}$/)
  assert(!f.calls.some((c) => c.method === "POST"))
})
test("pending cancellation with a late AWB reports its bound IDs and never permits replacement", async () => {
  const f = fixture()
  f.remotes[0].status = "CANCELLATION REQUESTED"
  f.remotes[0].status_code = 18
  f.remotes[0].shipments.status_code = 16
  f.remotes[0].shipments.awb = "SRTP_FIXTURE_171"
  await assert.rejects(
    recoverFulfillmentAttempt(f.api, input()),
    /cancellation is pending for order 100, shipment 42 \(order status 18, shipment status 16\) with AWB SRTP_FIXTURE_171/
  )
  assert(!f.calls.some((c) => c.method === "POST"))
})
test("pending cancellation diagnostics never include malformed remote AWB or status text", async () => {
  for (const awb of [
    "fixture@example.test",
    "unsafe tracking value",
    "A".repeat(101),
  ]) {
    const f = fixture()
    f.remotes[0].status = "CANCELLATION REQUESTED"
    f.remotes[0].shipments.awb = awb
    f.remotes[0].shipments.status_code = "private-status-text"
    await assert.rejects(
      recoverFulfillmentAttempt(f.api, input()),
      (error: any) => {
        assert.match(
          error.message,
          /order 100, shipment 42 \(order status 18\)/
        )
        assert.ok(!error.message.includes(awb))
        assert.ok(!error.message.includes("private-status-text"))
        return true
      }
    )
    assert(!f.calls.some((c) => c.method === "POST"))
  }
})
test("does not cancel shipped, registered, financially mismatched or wrong-warehouse attempts", async () => {
  for (const kind of [
    "shipped",
    "registered",
    "amount",
    "pickup",
    "items",
    "identity",
  ]) {
    const f = fixture(),
      i = input()
    if (kind === "shipped") f.remotes[0].status = "SHIPPED"
    if (kind === "registered") i.protected_order_ids = [100]
    if (kind === "amount") f.remotes[0].total = 999
    if (kind === "pickup") f.remotes[0].pickup_location_id = 999
    if (kind === "items") f.remotes[0].products[0].quantity = 2
    if (kind === "identity") f.remotes[0].id = 0
    await assert.rejects(recoverFulfillmentAttempt(f.api, i))
    assert(!f.calls.some((c) => c.method === "POST"))
  }
})
test("verifies all candidates before any cancellation and refuses multiple active booked attempts", async () => {
  const f = fixture(2)
  f.remotes[1].customer_pincode = "999999"
  await assert.rejects(recoverFulfillmentAttempt(f.api, input()))
  assert(!f.calls.some((c) => c.method === "POST"))
  const g = fixture(2)
  g.remotes[0].shipments.awb = "awb"
  g.remotes[0].shipments.courier_company_id = 8
  await assert.rejects(
    recoverFulfillmentAttempt(g.api, input()),
    /Multiple active/
  )
  assert(!g.calls.some((c) => c.method === "POST"))
})
test("ignores unrelated global latest orders and validates masked identity using shipment details", async () => {
  const f = fixture()
  f.remotes[0].customer_phone = "98xxxxxx10"
  f.remotes[0].shipments.awb = "VERIFIED_AWB"
  f.remotes[0].shipments.courier_company_id = 8
  f.remotes.push({
    ...structuredClone(f.remotes[0]),
    id: 999,
    channel_order_id: "unrelated-newest-order",
  })
  const result = await recoverFulfillmentAttempt(f.api, input())
  assert.equal(result.resume?.order_id, 100)
  assert.deepEqual(result.cancelled_order_ids, [])
  assert(!f.calls.some((c) => c.path === "/orders/show/999"))
})
test("legacy timestamps still belong to the same native order and must pass full comparison", async () => {
  const f = fixture()
  f.remotes[0].channel_order_id = "order_fixture-1794263026"
  f.remotes[0].shipments.awb = "VERIFIED_AWB"
  f.remotes[0].shipments.courier_company_id = 8
  const result = await recoverFulfillmentAttempt(f.api, input())
  assert.equal(result.reference, "order_fixture-1794263026")
})
test("malformed, incomplete, changed and ambiguous histories fail closed", async () => {
  const f = fixture()
  f.api.get = async () => ({ data: { data: null } }) as any
  await assert.rejects(
    recoverFulfillmentAttempt(f.api, input()),
    /history could not/
  )
  const g = fixture()
  g.api.get = async () =>
    ({ data: { data: [], meta: { pagination: { total_pages: 21 } } } }) as any
  await assert.rejects(
    recoverFulfillmentAttempt(g.api, input()),
    /history is incomplete/
  )
  const h = fixture(2)
  h.remotes[1].id = 100
  await assert.rejects(recoverFulfillmentAttempt(h.api, input()), /ambiguous/)
  const j = fixture()
  j.remotes[0].shipments = []
  await assert.rejects(
    recoverFulfillmentAttempt(j.api, input()),
    /cannot be identified/
  )
})
test("retry references stay within Shiprocket's 50-character limit", () => {
  assert.equal(retryReference(expected.order_id, 99999999).length, 50)
  for (const n of [-1, 0.5, 100000000])
    assert.throws(() => retryReference(expected.order_id, n))
})

test("a newly journaled order needs no account-wide shipment scan", async () => {
  const f = fixture(0)
  const result = await recoverFulfillmentAttempt(f.api, {
    ...input(),
    no_previous_attempt: true,
  })
  assert.equal(result.reference, expected.order_id)
  assert.equal(f.calls.length, 0)
})
test("a saved reference narrows inspection and remains stable if a create response was lost", async () => {
  const f = fixture(2),
    hint = retryReference(expected.order_id, 1)
  f.remotes[1].status = "CANCELED"
  const result = await recoverFulfillmentAttempt(f.api, {
    ...input(),
    reference_hint: hint,
  })
  assert.deepEqual(result.cancelled_order_ids, [101])
  assert.equal(result.reference, retryReference(expected.order_id, 2))
  assert.equal(f.remotes[0].status, "NEW")
  const g = fixture(0)
  const retry = await recoverFulfillmentAttempt(g.api, {
    ...input(),
    reference_hint: hint,
  })
  assert.equal(retry.reference, hint)
  await assert.rejects(
    recoverFulfillmentAttempt(g.api, {
      ...input(),
      reference_hint: "other-order",
    }),
    /does not belong/
  )
})

test("cancelled booked shipments never imply refunded shipping budget", async () => {
  const f = fixture()
  f.remotes[0].status = "CANCELED"
  f.remotes[0].shipments.awb = "previously-booked"
  await assert.rejects(
    recoverFulfillmentAttempt(f.api, input()),
    /cost\/refund/
  )
  assert(!f.calls.some((c) => c.method === "POST"))
})
test("a same-reference retry waits for a late AWB and then reuses it without any carrier write", async () => {
  const f = fixture()
  const wanted = { ...input(), reference_hint: expected.order_id }
  await assert.rejects(
    recoverFulfillmentAttempt(f.api, wanted),
    /assignment is still unconfirmed/
  )
  assert.equal(f.remotes[0].status, "NEW")
  f.remotes[0].shipments.awb = "LATE_VERIFIED_AWB"
  f.remotes[0].shipments.courier_company_id = 8
  const recovered = await recoverFulfillmentAttempt(f.api, wanted)
  assert.equal(recovered.reference, expected.order_id)
  assert.equal(recovered.resume?.order_id, 100)
  assert.equal(recovered.resume?.shipment_id, 42)
  assert.deepEqual(recovered.cancelled_order_ids, [])
  assert(!f.calls.some((c) => c.method === "POST"))
})

test("recovery reuses the verified booked parcel with original declared weight despite a rounded readback", async () => {
  const f = fixture()
  const wanted = { ...expected, shipping_is_billing: true, weight: 0.163 }
  f.remotes[0] = sameAddressRemoteFixture(wanted, {
    order_id: 100,
    shipment_id: 42,
    merchant_reference: expected.order_id,
  })
  const remote = f.remotes[0]
  remote.others.weight = "0.163"
  remote.shipments.weight = 0.16
  remote.status = "AWB ASSIGNED"
  remote.shipments.status = "AWB ASSIGNED"
  remote.shipments.awb = "verified_awb"
  remote.shipments.courier_company_id = 8
  const result = await recoverFulfillmentAttempt(f.api, {
    ...input(),
    order_data: wanted,
  })
  assert.equal(result.resume?.order_id, 100)
  assert.equal(result.resume?.shipment_id, 42)
  assert.deepEqual(result.cancelled_order_ids, [])
  assert(!f.calls.some((call) => call.method === "POST"))
})

test("buyer-data permissions block recovery with actionable guidance before cancellation or creation", async () => {
  const f = fixture()
  const wanted = { ...expected, shipping_is_billing: true, weight: 0.163 }
  f.remotes[0] = sameAddressRemoteFixture(wanted, {
    order_id: 100,
    shipment_id: 42,
    merchant_reference: expected.order_id,
  })
  f.remotes[0].others.weight = "0.163"
  f.remotes[0].shipments.weight = 0.16
  const get = f.api.get
  f.api.get = async (path) => {
    const response = await get(path)
    if (path.startsWith("/shipments/")) {
      const detail = (response as any).data.data
      for (const field of ["first_name", "last_name", "phone"])
        detail.customer_details[field] = "Not Authorized"
      for (const field of ["address", "address_2"])
        detail.shipping_address[field] = "Not Authorized"
    }
    return response
  }
  await assert.rejects(
    recoverFulfillmentAttempt(f.api, { ...input(), order_data: wanted }),
    (error: any) => {
      assert.match(error.message, /Buyer's Details Access.*Allowed/)
      assert(error.message.includes(SHIPROCKET_BUYER_DETAILS_ACCESS_MESSAGE))
      return true
    }
  )
  assert(f.calls.some((call) => call.path === "/shipments/42"))
  assert(!f.calls.some((call) => call.method === "POST"))
})

test("read-only cancellation verification returns the original base and next safe reference without any write callback", async () => {
  for (const [status, status_code] of [
    ["CANCELED", 5],
    ["Canceled before Dispatched", 54],
    [5, 5],
  ]) {
    const f = fixture()
    f.remotes[0].status = status
    f.remotes[0].status_code = status_code
    const result = await recoverFulfillmentAttempt(
      f.api,
      {
        ...input(),
        reference_hint: expected.order_id,
        allow_cancel: false,
      },
      () => {
        throw Error("Read-only verification invoked a write callback")
      }
    )
    assert.equal(result.base_reference, expected.order_id)
    assert.equal(result.reference, retryReference(expected.order_id, 1))
    assert.equal(result.verified_attempts, 1)
    assert.deepEqual(result.cancelled_order_ids, [100])
    assert(!f.calls.some((call) => call.method === "POST"))
  }
})

test("read-only cancellation verification cannot turn active, booked, missing or contradictory records into permission to switch", async () => {
  for (const kind of [
    "active",
    "booked",
    "pending",
    "linked",
    "missing",
    "identity",
    "contradiction",
  ]) {
    const f = fixture(kind === "missing" ? 0 : 1)
    const i = {
      ...input(),
      reference_hint: expected.order_id,
      allow_cancel: false,
    }
    if (f.remotes.length) f.remotes[0].status = "CANCELED"
    if (kind === "active") f.remotes[0].status = "NEW"
    if (kind === "booked") f.remotes[0].shipments.awb = "PREVIOUSLY-BOOKED"
    if (kind === "pending") {
      f.remotes[0].status = 18
      f.remotes[0].status_code = 18
    }
    if (kind === "linked") i.protected_order_ids = [100]
    if (kind === "identity") f.remotes[0].channel_order_id = "foreign"
    if (kind === "contradiction") f.remotes[0].status_code = 1
    await assert.rejects(recoverFulfillmentAttempt(f.api, i), kind)
    assert(!f.calls.some((call) => call.method === "POST"), kind)
  }
})

test("read-only cancellation verification requires the exact saved reference and rejects a no-history shortcut", async () => {
  for (const patch of [
    { reference_hint: undefined },
    { no_previous_attempt: true },
    { reference_hint: "foreign" },
  ]) {
    const f = fixture()
    await assert.rejects(
      recoverFulfillmentAttempt(f.api, {
        ...input(),
        reference_hint: expected.order_id,
        allow_cancel: false,
        ...patch,
      })
    )
    assert.equal(f.calls.length, 0)
  }
})

test("read-only cancellation handoff rejects historical booking or pickup markers even after the AWB was cleared", async () => {
  for (const marker of [
    "awb_assign_date",
    "awb_assigned_date",
    "pickup_scheduled_date",
    "pickup_generated_date",
  ]) {
    const f = fixture()
    f.remotes[0].status = "CANCELED"
    f.remotes[0].shipments[marker] = "2026-11-16 12:00:00"
    await assert.rejects(
      recoverFulfillmentAttempt(f.api, {
        ...input(),
        reference_hint: expected.order_id,
        allow_cancel: false,
      }),
      /booking or pickup history/
    )
    assert(!f.calls.some((call) => call.method === "POST"))
  }
})

test("normal recovery cannot advance a cancelled reference with booking or pickup history after the AWB was cleared", async () => {
  for (const marker of [
    "awb_assign_date",
    "awb_assigned_date",
    "pickup_scheduled_date",
    "pickup_generated_date",
  ]) {
    const f = fixture()
    f.remotes[0].status = "CANCELED"
    f.remotes[0].shipments.awb = ""
    f.remotes[0].shipments[marker] = "2026-11-17 01:59:49"
    await assert.rejects(
      recoverFulfillmentAttempt(f.api, {
        ...input(),
        reference_hint: expected.order_id,
      }),
      /booking or pickup history.*carrier cost\/refund/
    )
    assert(!f.calls.some((call) => call.method === "POST"))
  }
})

test("manual AWB mode can resume only one fully verified unassigned draft without carrier writes", async () => {
  const f = fixture()
  const recovered = await recoverFulfillmentAttempt(f.api, {
    ...input(),
    allow_unassigned_resume: true,
  })
  assert.equal(recovered.resume?.order_id, 100)
  assert.equal(recovered.resume?.shipment_id, 42)
  assert.equal(recovered.resume?.merchant_reference, expected.order_id)
  assert.ok(recovered.resume?.review_digest)
  assert.ok(!f.calls.some((c) => c.method === "POST"))
  const ambiguous = fixture(2)
  await assert.rejects(
    recoverFulfillmentAttempt(ambiguous.api, {
      ...input(),
      allow_unassigned_resume: true,
    }),
    /Multiple active/
  )
})
