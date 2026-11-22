import test from "node:test"
import assert from "node:assert/strict"
import axios from "axios"
import Service, { sealPassword } from "../modules/shiprocket-connection/service"
import {
  operationalSave,
  operationalSettings,
  defaultOperationalSettings,
} from "../shared/operational-settings"
function setup(t: any) {
  const previous = { ...process.env },
    adapter = axios.defaults.adapter
  process.env.JWT_SECRET = "operational-fixture-key-at-least-32-characters"
  process.env.SHIPROCKET_ENABLED = "false"
  process.env.SHIPROCKET_MULTIPLE_ITEMS = "single_shipment"
  process.env.SHIPROCKET_MISSING_MEASUREMENTS = "use_defaults"
  t.after(() => {
    for (const key of Object.keys(process.env))
      if (!(key in previous)) delete process.env[key]
    Object.assign(process.env, previous)
    axios.defaults.adapter = adapter
  })
  const rows: Record<string, any> = {
    shiprocket_preferences: {
      settings: {
        ...defaultOperationalSettings(),
        multiple_items: "single_shipment",
        missing_measurements: "use_defaults",
      },
      revision: 1,
      updated_at: new Date(),
      webhook_token_ciphertext: null,
      assignment_secret_ciphertext: sealPassword(
        process.env.JWT_SECRET!,
        "shiprocket-preferences:assignment"
      ),
    },
    shiprocket_connection: {
      id: "shiprocket",
      email: "fixture@example.test",
      mode: "test",
      password_ciphertext: "unused",
      revision: 1,
    },
  }
  const db: any = (table: string) => ({
    where: () => ({ first: async () => rows[table] }),
  })
  db.raw = async (_sql: string, values: any[]) => {
    const row = rows.shiprocket_preferences
    if (row && row.revision !== values[3]) return { rows: [] }
    rows.shiprocket_preferences = {
      ...row,
      settings: JSON.parse(values[0]),
      webhook_token_ciphertext: values[1],
      updated_by: values[2],
      revision: (row?.revision ?? 0) + 1,
      updated_at: new Date(),
    }
    return { rows: [{ id: "shiprocket" }] }
  }
  return { service: new Service({ manager: { getKnex: () => db } }), rows }
}
test("operational database snapshot masks the token and ignores conflicting environment values", async (t) => {
  const { service, rows } = setup(t)
  const first = await service.preferences()
  assert.equal(first.revision, 1)
  assert.equal(first.settings.multiple_items, "single_shipment")
  const token = "fixture-webhook-token-at-least-32-characters"
  await service.savePreferences(
    {
      revision: 1,
      settings: { ...first.settings, enabled: true, timeout: 90000 },
      webhook_token: token,
    },
    "actor"
  )
  assert.notEqual(rows.shiprocket_preferences.webhook_token_ciphertext, token)
  assert.equal(await service.webhookToken(), token)
  assert.doesNotMatch(
    JSON.stringify(await service.preferences()),
    /fixture-webhook|ciphertext|password/
  )
  process.env.SHIPROCKET_MULTIPLE_ITEMS = "invalid-stale-value"
  process.env.SHIPROCKET_API_TIMEOUT_MS = "invalid-stale-value"
  process.env.SHIPROCKET_WEBHOOK_TOKEN = "other"
  assert.equal((await service.runtimeSettings()).timeout, 90000)
  await service.savePreferences(
    {
      revision: 2,
      settings: { ...first.settings, enabled: true, timeout: 120000 },
    },
    "actor"
  )
  assert.equal(await service.webhookToken(), token)
  const calls: any[] = []
  axios.defaults.adapter = async (config) => {
    calls.push(config)
    return {
      data: { token: "private-carrier-token" },
      config,
      status: 200,
      statusText: "OK",
      headers: {},
    }
  }
  await service.verify(
    {
      email: "fixture@example.test",
      password: "new-password",
      mode: "test",
      revision: 1,
    },
    "actor"
  )
  assert.equal(calls[0].timeout, 120000)
  assert.equal(rows.shiprocket_connection.revision, 1)
})
test("only one concurrent settings save wins; failed edits preserve settings and token", async (t) => {
  const { service, rows } = setup(t),
    settings = await service.runtimeSettings()
  const results = await Promise.allSettled(
    [60000, 90000].map((timeout) =>
      service.savePreferences(
        { revision: 1, settings: { ...settings, timeout } },
        "actor"
      )
    )
  )
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1)
  const before = JSON.stringify(await service.preferences())
  await assert.rejects(
    () => service.savePreferences({ revision: 0, settings }, "actor"),
    /changed/
  )
  await assert.rejects(() =>
    service.savePreferences(
      { revision: 2, settings: { ...settings, timeout: 999 } },
      "actor"
    )
  )
  await assert.rejects(
    () =>
      service.savePreferences(
        { revision: 2, settings: { ...settings, enabled: true } },
        "actor"
      ),
    /webhook token/
  )
  assert.equal(JSON.stringify(await service.preferences()), before)
  delete rows.shiprocket_connection
  await assert.rejects(
    () => service.savePreferences({ revision: 2, settings }, "actor"),
    /verified credentials/
  )
})
test("strict schema rejects unknown fields, invalid enums, non-booleans and unsafe limits", (t) => {
  setup(t)
  const settings = defaultOperationalSettings()
  assert.equal(settings.default_item_weight_grams, 500)
  assert.equal(settings.default_item_length_mm, 6)
  assert.equal(settings.timeout, 60000)
  assert.ok(
    operationalSettings.safeParse({ ...settings, rounding_rupees: 25 }).success
  )
  for (const patch of [
    { timeout: 999 },
    { timeout: 300001 },
    { timeout: 1.5 },
    { enabled: "true" },
    { default_item_length_mm: 5 },
    { default_item_weight_grams: 0 },
    { multiple_items: "bulk" },
    { courier_selection: "random" },
    { courier_fallback: "ignore" },
    { webhook_payload_retention_days: 0 },
    { webhook_payload_retention_days: 366 },
    { rate_cache_ttl_ms: -1 },
    { rounding_rupees: 0 },
    { rounding_rupees: 1.5 },
    { secret: "injected" },
  ])
    assert.equal(
      operationalSettings.safeParse({ ...settings, ...patch }).success,
      false
    )
  assert.equal(
    operationalSave.safeParse({ revision: 1, settings, webhook_token: "short" })
      .success,
    false
  )
  assert.equal(
    operationalSave.safeParse({ revision: 1, settings, mode: "live" }).success,
    false
  )
})
