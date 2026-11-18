import test from "node:test"
import assert from "node:assert/strict"
import { POST } from "../api/hooks/fulfillment/delivery-updates/route"
import { SHIPROCKET_ORDER_CANCELLED_EVENT } from "../shared/order-cancellation"

const token = "webhook-fixture-only-token-at-least-32-characters"
let requestNumber = 0
async function request(
  t: any,
  body: any,
  authenticated = true,
  options: { bus?: "v1" | "v2" | "missing"; reject?: boolean } = {}
) {
  const previous = process.env.SHIPROCKET_WEBHOOK_TOKEN
  process.env.SHIPROCKET_WEBHOOK_TOKEN = token
  t.after(() => {
    if (previous === undefined) delete process.env.SHIPROCKET_WEBHOOK_TOKEN
    else process.env.SHIPROCKET_WEBHOOK_TOKEN = previous
  })
  const messages: string[] = []
  const resolved: string[] = []
  const events: any[] = []
  const emit = async (...args: any[]) => {
    if (options.reject) throw Error("Fixture enqueue failed")
    events.push(args)
  }
  let status = 200,
    result: any
  const response: any = {
    status(code: number) {
      status = code
      return this
    },
    json(value: any) {
      result = value
      return this
    },
  }
  await POST(
    {
      body,
      headers: authenticated ? { "x-api-key": token } : {},
      ip: `198.51.100.${++requestNumber}`,
      scope: {
        resolve(key: string) {
          if (key === "shiprocketConnection")
            return {
              webhookToken: async () => process.env.SHIPROCKET_WEBHOOK_TOKEN,
            }
          resolved.push(key)
          if (key === "logger")
            return {
              info: (m: string) => messages.push(m),
              warn: () => {},
              error: () => {},
            }
          if (key === "event_bus" && (options.bus ?? "v2") === "v2")
            return { emit }
          if (key === "eventBusService" && options.bus === "v1") return { emit }
          throw Error(
            "Only logger and event bus may be resolved for untrackable cancellations"
          )
        },
      },
    } as any,
    response
  )
  return { status, result, resolved, messages, events }
}
const cancellation = {
  awb: "",
  current_status: "CANCELED",
  current_status_id: 5,
  shipment_status: "CANCELLED",
  shipment_status_id: 8,
  sr_order_id: 123,
  order_id: "medusa_recorded_reference",
  current_timestamp: "2026-11-16 12:00:00",
  awb_assigned_date: null,
  pickup_scheduled_date: null,
}

test("authenticated pre-AWB cancellation emits a public advisory event and deduplicates without tracking or journal writes", async (t) => {
  const first = await request(t, cancellation)
  assert.equal(first.status, 200)
  assert.equal(first.result.processed, true)
  assert.equal(first.result.ignored, undefined)
  assert.equal(first.result.reason, "cancelled_before_awb")
  assert.equal(first.result.sr_order_id, 123)
  assert.deepEqual(first.resolved, ["logger", "event_bus"])
  assert.equal(first.events.length, 1)
  assert.equal(first.events[0][0].name, SHIPROCKET_ORDER_CANCELLED_EVENT)
  assert.deepEqual(first.events[0][0].data, {
    sr_order_id: 123,
    order_id: cancellation.order_id,
    before_awb: true,
    current_status: "CANCELED",
    current_status_id: 5,
    shipment_status: "CANCELLED",
    shipment_status_id: 8,
    current_timestamp: cancellation.current_timestamp,
  })
  const duplicate = await request(t, cancellation)
  assert.equal(duplicate.status, 200)
  assert.equal(duplicate.result.processed, true)
  assert.equal(duplicate.result.duplicate, true)
  assert.equal(duplicate.events.length, 0)
  assert.deepEqual(duplicate.resolved, ["logger"])
})

test("distinct canceled orders do not collide on blank AWB and identical timestamps", async (t) => {
  const result = await request(t, { ...cancellation, sr_order_id: 124 })
  assert.equal(result.status, 200)
  assert.equal(result.events.length, 1)
})

test("documented cancellation-before-dispatch statuses use their separate order and shipment namespaces", async (t) => {
  const result = await request(t, {
    ...cancellation,
    sr_order_id: 125,
    current_status: "Canceled before Dispatched",
    current_status_id: 54,
    shipment_status: "CANCELLED_BEFORE_DISPATCHED",
    shipment_status_id: 45,
  })
  assert.equal(result.status, 200)
  assert.equal(result.result.processed, true)
  assert.equal(result.events.length, 1)
})

test("failed cancellation enqueue remains retryable and legacy event buses receive the public event", async (t) => {
  const payload = { ...cancellation, sr_order_id: 126 }
  const failed = await request(t, payload, true, { reject: true })
  assert.equal(failed.status, 500)
  const retry = await request(t, payload, true, { bus: "v1" })
  assert.equal(retry.status, 200)
  assert.equal(retry.events[0][0], SHIPROCKET_ORDER_CANCELLED_EVENT)
  assert.equal(retry.events[0][1].sr_order_id, 126)
  const missing = await request(
    t,
    { ...cancellation, sr_order_id: 127 },
    true,
    { bus: "missing" }
  )
  assert.equal(missing.status, 500)
})

test("pre-AWB cancellation still requires valid webhook authentication", async (t) => {
  const result = await request(t, cancellation, false)
  assert.equal(result.status, 401)
  assert.equal(result.result.code, "UNAUTHORIZED")
  assert.deepEqual(result.resolved, ["logger"])
})

test("missing AWB on tracking updates and contradictory or malformed cancellations remain rejected", async (t) => {
  for (const patch of [
    { current_status: "DELIVERED" },
    { shipment_status: "PICKED UP" },
    { current_status_id: 1 },
    { shipment_status_id: 7 },
    { sr_order_id: 0 },
    { sr_order_id: "123" },
    { awb_assigned_date: "2026-11-15" },
    { pickup_scheduled_date: "2026-11-15" },
    { awb: "bad" },
    { awb: undefined },
  ]) {
    const result = await request(t, { ...cancellation, ...patch })
    assert.equal(result.status, 400)
    assert.equal(result.result.code, "INVALID_PAYLOAD")
    assert.deepEqual(result.resolved, ["logger"])
  }
})
