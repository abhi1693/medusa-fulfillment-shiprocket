import test from "node:test"
import assert from "node:assert/strict"
import axios from "axios"
import ShiprocketClient from "../providers/shiprocket/client"
import { resetShiprocketManager } from "../providers/shiprocket/client/manager"
import { POST as pickupRoute } from "../api/admin/shiprocket/tracking/[awb]/pickup/route"
import { POST as syncRoute } from "../api/admin/shiprocket/tracking/[awb]/sync/route"
import { carrierDate } from "../shared/carrier-date"

function setup(t: any) {
  const adapter = axios.defaults.adapter
  const env = { ...process.env }
  process.env.SHIPROCKET_EMAIL = "fixture@example.test"
  process.env.SHIPROCKET_PASSWORD = "fixture-only"
  process.env.SHIPROCKET_VERIFY_DOCUMENTS = "false"
  resetShiprocketManager()
  const calls: any[] = [],
    logs: string[] = []
  const logger: any = Object.fromEntries(
    ["info", "warn", "error", "debug"].map((k) => [
      k,
      (m: string) => logs.push(m),
    ])
  )
  const state: any = {
    pickup: {
      pickup_status: 1,
      response: { pickup_scheduled_date: "2026-11-18 10:00:00" },
    },
    shipment: { id: 42, order_id: 100, awb: "AWB123456", status: 1 },
    manifest: {
      status: 1,
      manifest_url: "https://carrier.example.test/manifest.pdf",
    },
    label: {
      label_created: 1,
      label_url: "https://carrier.example.test/label.pdf",
    },
    invoice: {
      is_invoice_created: true,
      invoice_url: "https://carrier.example.test/invoice.pdf",
    },
    tracking: { tracking_data: { track_status: 0 } },
  }
  axios.defaults.adapter = async (config: any) => {
    calls.push({
      url: config.url,
      data:
        typeof config.data === "string" ? JSON.parse(config.data) : config.data,
    })
    let data: any
    if (config.url === "/auth/login") data = { token: "fixture-token" }
    else if (config.url === "/shipments/42") data = { data: state.shipment }
    else if (config.url === "/courier/generate/pickup") data = state.pickup
    else if (config.url === "/courier/track/awb/AWB123456")
      data = state.tracking
    else if (config.url === "/courier/generate/label") data = state.label
    else if (config.url === "/orders/print/invoice") data = state.invoice
    else if (config.url === "/manifests/print")
      data = { manifest_url: state.manifest.manifest_url }
    else if (config.url === "/manifests/generate") {
      if (state.manifestError) throw state.manifestError
      data = state.manifest
    } else throw Error(`Unexpected request ${config.url}`)
    if (data instanceof Error) throw data
    return { data, status: 200, statusText: "OK", config, headers: {} }
  }
  t.after(() => {
    axios.defaults.adapter = adapter
    resetShiprocketManager()
    for (const key of [
      "SHIPROCKET_EMAIL",
      "SHIPROCKET_PASSWORD",
      "SHIPROCKET_VERIFY_DOCUMENTS",
    ]) {
      if (env[key] === undefined) delete process.env[key]
      else process.env[key] = env[key]
    }
  })
  const client = new ShiprocketClient({
    email: process.env.SHIPROCKET_EMAIL,
    password: process.env.SHIPROCKET_PASSWORD,
    logger,
  })
  const fulfillment: any = {
    id: "ful_fixture",
    labels: [
      {
        id: "label_fixture",
        tracking_number: "AWB123456",
        tracking_url: "https://carrier.example.test/track",
        label_url: "",
      },
    ],
    provider_id: "shiprocket_shiprocket",
    data: {
      order_id: 100,
      shipment_id: 42,
      tracking_number: "AWB123456",
      merchant_note: "preserve",
    },
  }
  let tracking: any = null
  const updates: any[] = []
  async function route(
    handler: any,
    body: any = { fulfillment_id: fulfillment.id },
    awb = "AWB123456"
  ) {
    let status = 200,
      result: any
    await handler(
      {
        params: { awb },
        body,
        scope: {
          resolve(key: string) {
            if (key === "shiprocketConnection")
              return {
                runtime: async () => ({
                  email: process.env.SHIPROCKET_EMAIL,
                  password: process.env.SHIPROCKET_PASSWORD,
                  mode: process.env.SHIPROCKET_MODE ?? "test",
                }),
              }
            if (key === "logger") return logger
            if (key === "locking")
              return { execute: async (_key: string, job: any) => job() }
            if (key === "fulfillment")
              return {
                retrieveFulfillment: async () => fulfillment,
                updateFulfillment: async (_id: any, update: any) => {
                  updates.push(update)
                  Object.assign(fulfillment, update)
                },
              }
            if (key === "shiprocketTrackingModuleService")
              return {
                findByAwb: async () => tracking,
                upsertByAwb: async (data: any) => {
                  updates.push(data)
                  tracking = {
                    id: "track_fixture",
                    ...tracking,
                    ...Object.fromEntries(
                      Object.entries(data).filter(([, v]) => v !== undefined)
                    ),
                  }
                  return tracking
                },
              }
            throw Error("Unexpected service")
          },
        },
      },
      {
        status(code: number) {
          status = code
          return this
        },
        json(value: any) {
          result = value
          return this
        },
      }
    )
    return { status, result }
  }
  return { client, state, calls, logs, fulfillment, updates, route }
}

test("pickup requires semantic confirmation and preserves the carrier slot", async (t) => {
  const f = setup(t)
  assert.deepEqual(await f.client.requestPickup("42"), {
    scheduled: true,
    raw_response: f.state.pickup,
    pickup_scheduled_date: "2026-11-18 10:00:00",
  })
  assert.deepEqual(f.calls.find((c) => c.url.endsWith("/pickup")).data, {
    shipment_id: [42],
  })
  for (const body of [{ pickup_status: 0 }, {}, { pickup_status: "1" }]) {
    f.state.pickup = body
    assert.equal(await f.client.schedulePickup(42), false)
  }
})

test("pickup validates IDs and formats explicit future dates in IST", async (t) => {
  const f = setup(t)
  for (const id of [null, "", 0, -1, 1.2, "bad"])
    assert.equal(await f.client.schedulePickup(id as any), false)
  assert.equal(f.calls.length, 0)
  await f.client.requestPickup(42, new Date("2026-11-18T20:00:00Z"))
  assert.deepEqual(f.calls[f.calls.length - 1].data.pickup_date, ["2026-11-19"])
})

test("pickup transport failure is not reported as success or automatically replayed", async (t) => {
  const f = setup(t)
  f.state.pickup = Error("fixture timeout")
  assert.equal(await f.client.schedulePickup(42), false)
  assert.equal(f.calls.filter((c) => c.url.endsWith("/pickup")).length, 1)
})

test("documents use shipment IDs for manifests/labels, order IDs for invoices, and defer manifest until pickup", async (t) => {
  const f = setup(t)
  const first = await f.client.createDocuments(f.fulfillment.data)
  assert.equal(first.manifest, "")
  assert.ok(!f.calls.some((c) => c.url === "/manifests/generate"))
  const docs = await f.client.createDocuments(f.fulfillment.data, {
    pickupConfirmed: true,
  })
  assert.ok(docs.manifest && docs.label && docs.invoice)
  assert.deepEqual(f.calls.find((c) => c.url === "/manifests/generate").data, {
    shipment_id: [42],
  })
  assert.deepEqual(
    f.calls.find((c) => c.url === "/courier/generate/label").data,
    { shipment_id: [42] }
  )
  assert.deepEqual(
    f.calls.find((c) => c.url === "/orders/print/invoice").data,
    { ids: [100] }
  )
})

test("document HTTP 200 failures, empty or unsafe URLs remain unavailable with bounded diagnostics", async (t) => {
  const f = setup(t)
  f.state.label = {
    label_created: 0,
    label_url: "https://carrier.example.test/invalid.pdf",
    response: "private-person@example.test",
  }
  f.state.manifest.manifest_url = ""
  f.state.invoice.invoice_url = "javascript:alert(1)"
  assert.deepEqual(
    await f.client.createDocuments(f.fulfillment.data, {
      pickupConfirmed: true,
    }),
    { manifest: "", label: "", invoice: "" }
  )
  assert.ok(
    f.logs.filter((l) => l.includes("document unavailable")).length >= 3
  )
  assert.ok(!f.logs.join().includes("private-person"))
})

test("standalone label and invoice helpers reject semantic failures and unsafe URLs", async (t) => {
  const f = setup(t)
  assert.ok(await f.client.generateLabel(f.fulfillment.data))
  assert.ok(await f.client.generateInvoice(f.fulfillment.data))
  f.state.label.label_created = 0
  f.state.invoice.is_invoice_created = false
  assert.equal(await f.client.generateLabel(f.fulfillment.data), "")
  assert.equal(await f.client.generateInvoice(f.fulfillment.data), "")
  f.state.label = { label_created: 1, label_url: "javascript:alert(1)" }
  assert.equal(await f.client.generateLabel(f.fulfillment.data), "")
})

test("already manifested exact shipment uses print with order_ids, unrelated failure does not", async (t) => {
  const f = setup(t)
  f.state.manifestError = {
    response: { status: 400, data: { already_manifested_shipment_ids: [42] } },
  }
  assert.ok(
    (
      await f.client.createDocuments(f.fulfillment.data, {
        pickupConfirmed: true,
      })
    ).manifest
  )
  assert.deepEqual(f.calls.find((c) => c.url === "/manifests/print").data, {
    order_ids: [100],
  })
  f.calls.length = 0
  f.state.manifestError.response.data.already_manifested_shipment_ids = [43]
  assert.equal(
    (
      await f.client.createDocuments(f.fulfillment.data, {
        pickupConfirmed: true,
      })
    ).manifest,
    ""
  )
  assert.ok(!f.calls.some((c) => c.url === "/manifests/print"))
  f.state.manifestError.response.data.already_manifested_shipment_ids = "42"
  assert.equal(
    (
      await f.client.createDocuments(f.fulfillment.data, {
        pickupConfirmed: true,
      })
    ).manifest,
    ""
  )
})

test("pickup route persists acknowledgement and retry reads existing pickup without another POST", async (t) => {
  const f = setup(t)
  assert.equal((await f.route(pickupRoute)).status, 200)
  assert.equal(f.fulfillment.data.shiprocket_pickup_confirmed, true)
  assert.equal(f.fulfillment.data.merchant_note, "preserve")
  f.state.shipment.status = 3
  assert.equal((await f.route(pickupRoute)).result.pickup.scheduled, true)
  assert.equal(
    f.calls.filter((c) => c.url === "/courier/generate/pickup").length,
    1
  )
})

test("an uncertain pickup retains a durable pending marker and cannot be replayed until carrier confirmation", async (t) => {
  const f = setup(t)
  f.state.pickup = Error("fixture timeout")
  assert.equal((await f.route(pickupRoute)).status, 409)
  assert.equal(f.fulfillment.data.shiprocket_pickup_pending, true)
  assert.equal((await f.route(pickupRoute)).status, 409)
  assert.equal(
    f.calls.filter((c) => c.url === "/courier/generate/pickup").length,
    1
  )
  f.state.shipment.status = 3
  assert.equal((await f.route(pickupRoute)).status, 200)
  assert.equal(f.fulfillment.data.shiprocket_pickup_pending, false)
  assert.equal(
    f.calls.filter((c) => c.url === "/courier/generate/pickup").length,
    1
  )
})

test("an explicit pickup rejection remains retryable without a false acknowledgement", async (t) => {
  const f = setup(t)
  f.state.pickup = { pickup_status: 0, message: "Fixture rejected" }
  assert.equal((await f.route(pickupRoute)).status, 400)
  assert.equal(f.fulfillment.data.shiprocket_pickup_pending, false)
  assert.notEqual(f.fulfillment.data.shiprocket_pickup_confirmed, true)
  f.state.pickup = { pickup_status: 1 }
  assert.equal((await f.route(pickupRoute)).status, 200)
})

test("pickup rejects absent or mismatching native AWBs, cancelled and mismatching remote shipments", async (t) => {
  const f = setup(t)
  assert.equal(
    (await f.route(pickupRoute, undefined, "OTHER123456")).status,
    400
  )
  assert.equal(f.calls.length, 0)
  for (const patch of [
    { awb: "OTHER123456" },
    { order_id: 101 },
    { id: 43 },
    { status: 8 },
    { status: 16 },
  ]) {
    const previous = { ...f.state.shipment }
    Object.assign(f.state.shipment, patch)
    assert.equal((await f.route(pickupRoute)).result.success, false)
    f.state.shipment = previous
  }
  assert.ok(!f.calls.some((c) => c.url === "/courier/generate/pickup"))
  assert.equal(f.updates.length, 0)
})

test("sync recovers pickup without activity scans and preserves stored document URLs on partial failure", async (t) => {
  const f = setup(t)
  f.state.shipment.status = 3
  f.state.shipment.pickup_scheduled_date = "2026-11-18 10:00:00"
  let response = await f.route(syncRoute)
  assert.equal(response.status, 200)
  assert.equal(response.result.pickup.scheduled, true)
  assert.equal(response.result.tracking.current_status, "Pickup Scheduled")
  assert.equal(f.fulfillment.data.shiprocket_pickup_confirmed, true)
  assert.equal(
    f.fulfillment.labels[0].label_url,
    "https://carrier.example.test/label.pdf"
  )
  const manifest = f.fulfillment.data.manifest_url
  f.state.label = { label_created: 0 }
  f.state.manifest = { status: 1, manifest_url: "" }
  delete f.state.shipment.pickup_scheduled_date
  response = await f.route(syncRoute)
  assert.equal(f.fulfillment.data.manifest_url, manifest)
  const trackingUpdates = f.updates.filter((d) => d.awb)
  assert.equal(
    trackingUpdates[0].pickup_scheduled_date.toISOString(),
    "2026-11-18T04:30:00.000Z"
  )
  assert.equal(trackingUpdates[1].pickup_scheduled_date, undefined)
  assert.notEqual(response.result.tracking.current_status, "AWB Assigned")
  assert.ok(!f.calls.some((c) => c.url === "/courier/generate/pickup"))
})

test("a later confirmed pickup advances a stored Unknown status without fabricating activity scans", async (t) => {
  const f = setup(t)
  assert.equal(
    (await f.route(syncRoute)).result.tracking.current_status,
    "Unknown"
  )
  f.state.shipment.status = 3
  assert.equal(
    (await f.route(syncRoute)).result.tracking.current_status,
    "Pickup Scheduled"
  )
})

test("verified shipment documents remain retryable when activity tracking fails or has no data", async (t) => {
  const f = setup(t)
  f.state.shipment.status = 3
  for (const tracking of [{}, Error("Fixture tracking unavailable")]) {
    f.state.tracking = tracking
    const response = await f.route(syncRoute)
    assert.equal(response.status, 200)
    assert.ok(response.result.documents.label_url)
    assert.ok(response.result.documents.manifest_url)
  }
  assert.ok(!f.calls.some((c) => c.url === "/courier/generate/pickup"))
})

test("sync validates binding before any mutation and skips documents when remote verification fails", async (t) => {
  const f = setup(t)
  assert.equal((await f.route(syncRoute, undefined, "OTHER123456")).status, 400)
  assert.equal(f.updates.length, 0)
  f.state.shipment.order_id = 101
  assert.equal((await f.route(syncRoute)).status, 200)
  assert.ok(!f.calls.some((c) => c.url.includes("generate")))
})

test("carrier dates reject invalid values and handle IST, date-only and zoned values", () => {
  assert.equal(
    carrierDate("2026-11-18 10:00:00")?.toISOString(),
    "2026-11-18T04:30:00.000Z"
  )
  assert.equal(
    carrierDate("2026-11-18")?.toISOString(),
    "2026-11-17T18:30:00.000Z"
  )
  assert.equal(
    carrierDate("2026-11-18T10:00:00Z")?.toISOString(),
    "2026-11-18T10:00:00.000Z"
  )
  for (const value of [null, "", "invalid"])
    assert.equal(carrierDate(value), undefined)
})

test("pickup error overrides retained dates and saved confirmation during document sync", async (t) => {
  const f = setup(t)
  f.state.shipment.status = 13
  f.state.shipment.pickup_generated_date = "2026-11-17 16:45:00"
  f.state.shipment.pickup_token_number = "old-attempt"
  f.fulfillment.data.shiprocket_pickup_confirmed = true
  assert.deepEqual(
    await f.client.inspectPickup(f.fulfillment.data, "AWB123456"),
    { scheduled: false, can_schedule: true, failed: true }
  )
  const result = await f.route(syncRoute)
  assert.equal(result.status, 200)
  assert.equal(f.fulfillment.data.shiprocket_pickup_confirmed, false)
  assert.equal(f.fulfillment.data.shiprocket_pickup_error, true)
  assert.ok(
    !f.calls.some((c) =>
      [
        "/manifests/generate",
        "/manifests/print",
        "/courier/generate/pickup",
      ].includes(c.url)
    )
  )
  assert.ok(f.calls.some((c) => c.url === "/courier/generate/label"))
  assert.ok(f.calls.some((c) => c.url === "/orders/print/invoice"))
  assert.match(
    f.fulfillment.data.shiprocket_document_status.manifest.message,
    /Pickup Error/
  )
  f.state.shipment.status = 3
  f.state.tracking = { tracking_data: { track_status: 1, current_status: 13 } }
  const recovered = await f.route(syncRoute)
  assert.equal(f.fulfillment.data.shiprocket_pickup_error, false)
  assert.equal(f.fulfillment.data.shiprocket_pickup_confirmed, true)
  assert.equal(recovered.result.tracking.current_status, "Pickup Scheduled")
  assert.deepEqual(f.fulfillment.data.shiprocket_document_status, {})
})

test("an explicit pickup action retries a verified pickup error with the documented retry status", async (t) => {
  const f = setup(t)
  f.state.shipment.status = 13
  f.state.shipment.pickup_generated_date = "2026-11-17 16:45:00"
  f.fulfillment.data.shiprocket_pickup_pending = true
  f.fulfillment.data.shiprocket_pickup_confirmed = true
  const result = await f.route(pickupRoute)
  assert.equal(result.status, 200)
  assert.deepEqual(
    f.calls.find((c) => c.url === "/courier/generate/pickup").data,
    { shipment_id: [42], status: "retry" }
  )
  assert.equal(f.fulfillment.data.shiprocket_pickup_pending, false)
  assert.equal(f.fulfillment.data.shiprocket_pickup_error, false)
})

test("successful pickup stores the entire original JSON and preserves it across readback and rejection", async (t) => {
  const f = setup(t)
  const raw = {
    pickup_status: 1,
    response: {
      pickup_scheduled_date: "2021-12-10 12:39:54",
      pickup_token_number: "Reference No: 194_BIGFOOT 1966840_11122021",
      status: 3,
      others: JSON.stringify({
        tier_id: 5,
        etd_hours: JSON.stringify({ assign_to_pick: 6.9 }),
        routing_code: "S2/S-69/1B/016",
        shipment_metadata: { type: "ship", platform: "desktop" },
      }),
      pickup_generated_date: {
        date: "2021-12-10 12:39:54.034695",
        timezone_type: 3,
        timezone: "Asia/Kolkata",
      },
      data: "Pickup is confirmed for AWB :- AWB123456",
    },
    additional_carrier_field: { keep: [1, "two", null] },
  }
  f.state.pickup = raw
  assert.equal((await f.route(pickupRoute)).status, 200)
  assert.deepEqual(f.fulfillment.data.shiprocket_pickup_response, raw)
  assert.equal(
    f.fulfillment.data.shiprocket_pickup_response.response.others,
    raw.response.others
  )
  f.state.shipment.status = 3
  await f.route(pickupRoute)
  await f.route(syncRoute)
  assert.deepEqual(f.fulfillment.data.shiprocket_pickup_response, raw)
  f.state.shipment.status = 13
  f.state.pickup = { pickup_status: 0, response: "Courier not available" }
  assert.equal((await f.route(pickupRoute)).status, 400)
  assert.deepEqual(f.fulfillment.data.shiprocket_pickup_response, raw)
})
