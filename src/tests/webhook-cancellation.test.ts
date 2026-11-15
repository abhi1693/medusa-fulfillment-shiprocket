import test from "node:test"
import assert from "node:assert/strict"
import { POST } from "../api/hooks/fulfillment/delivery-updates/route"

const token = "webhook-fixture-only-token-at-least-32-characters"
async function request(t: any, body: any, authenticated = true) {
  const previous = process.env.SHIPROCKET_WEBHOOK_TOKEN
  process.env.SHIPROCKET_WEBHOOK_TOKEN = token
  t.after(() => { if (previous === undefined) delete process.env.SHIPROCKET_WEBHOOK_TOKEN; else process.env.SHIPROCKET_WEBHOOK_TOKEN = previous })
  const messages: string[] = []
  const resolved: string[] = []
  let status = 200, result: any
  const response: any = { status(code: number) { status = code; return this }, json(value: any) { result = value; return this } }
  await POST({
    body, headers: authenticated ? {"x-api-key": token} : {}, ip: "198.51.100.123",
    scope: { resolve(key: string) { resolved.push(key); if (key === "logger") return {info: (m: string) => messages.push(m), warn: () => {}, error: () => {}}; throw Error("Tracking must not be resolved for untrackable events") } },
  } as any, response)
  return { status, result, resolved, messages }
}
const cancellation = { awb: "", current_status: "CANCELED", current_status_id: 5, shipment_status: "CANCELLED", shipment_status_id: 8, sr_order_id: 123, awb_assigned_date: null, pickup_scheduled_date: null }

test("authenticated pre-AWB cancellation is acknowledged without tracking writes, including retries", async (t) => {
  for (let i = 0; i < 2; i++) {
    const r = await request(t, cancellation)
    assert.equal(r.status, 200)
    assert.equal(r.result.ignored, true)
    assert.equal(r.result.reason, "cancelled_before_awb")
    assert.deepEqual(r.resolved, ["logger"])
    assert.ok(r.messages[0].includes("cancelled_before_awb"))
  }
})
test("pre-AWB cancellation still requires valid webhook authentication", async (t) => {
  const r = await request(t, cancellation, false)
  assert.equal(r.status, 401)
  assert.equal(r.result.code, "UNAUTHORIZED")
})
test("missing AWB on tracking updates and contradictory/malformed cancellations remain rejected", async (t) => {
  for (const patch of [
    {current_status: "DELIVERED"}, {shipment_status: "PICKED UP"},
    {sr_order_id: 0}, {sr_order_id: "123"}, {awb_assigned_date: "2026-11-15"},
    {pickup_scheduled_date: "2026-11-15"}, {awb: "bad"}, {awb: undefined},
  ]) {
    const r = await request(t, {...cancellation, ...patch})
    assert.equal(r.status, 400)
    assert.equal(r.result.code, "INVALID_PAYLOAD")
    assert.deepEqual(r.resolved, ["logger"])
  }
})
