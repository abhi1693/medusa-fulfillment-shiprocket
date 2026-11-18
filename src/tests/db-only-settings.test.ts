import test from "node:test"
import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import Service from "../modules/shiprocket-connection/service"
import { defaultOperationalSettings } from "../shared/operational-settings"
import { shipmentPolicy } from "../shared/shipment-policy"
import { courierPolicy } from "../providers/shiprocket/utils/courier-policy"
import {
  shiprocketApiUrl,
  shiprocketTimeout,
} from "../providers/shiprocket/client/config"
import {
  getShiprocketManager,
  hasShiprocketCredentials,
} from "../providers/shiprocket/client/manager"
import { assignmentSecret } from "../shared/deferred-awb"
function hostileEnvironment(t: any) {
  const previous = { ...process.env }
  Object.assign(process.env, {
    SHIPROCKET_ENABLED: "true",
    SHIPROCKET_MODE: "live",
    SHIPROCKET_EMAIL: "stale@example.test",
    SHIPROCKET_PASSWORD: "stale-private-password",
    SHIPROCKET_API_TIMEOUT_MS: "invalid",
    SHIPROCKET_MULTIPLE_ITEMS: "single_shipment",
    SHIPROCKET_MISSING_MEASUREMENTS: "use_defaults",
    SHIPROCKET_DEFAULT_ITEM_WEIGHT_GRAMS: "999",
    SHIPROCKET_COURIER_SELECTION: "highest_rating",
    SHIPROCKET_REQUIRE_REAL_TIME_TRACKING: "true",
    SHIPROCKET_COURIER_FALLBACK: "none",
    SHIPROCKET_WEBHOOK_TOKEN: "stale-fixture-token-at-least-32-characters",
    SHIPROCKET_ASSIGNMENT_SECRET: "stale-assignment-key-at-least-32-characters",
  })
  t.after(() => {
    for (const k of Object.keys(process.env))
      if (!(k in previous)) delete process.env[k]
    Object.assign(process.env, previous)
  })
}
test("transport and policy helpers never read stale carrier environment values", (t) => {
  hostileEnvironment(t)
  assert.equal(shiprocketTimeout(), 60000)
  assert.equal(
    shiprocketApiUrl(),
    "https://api-sandbox.shiprocket.in/v1/external"
  )
  assert.equal(hasShiprocketCredentials(), false)
  assert.equal(
    hasShiprocketCredentials({
      email: "database@example.test",
      password: "database-password",
    }),
    true
  )
  assert.throws(() => getShiprocketManager(), /email and password/i)
  assert.throws(() => assignmentSecret(), /assignment secret/)
  assert.equal(
    assignmentSecret("explicit-database-key-at-least-32-characters"),
    "explicit-database-key-at-least-32-characters"
  )
  const packing = shipmentPolicy(),
    courier = courierPolicy(),
    defaults = defaultOperationalSettings()
  assert.equal(packing.multiple_items, "split_shipment")
  assert.equal(packing.missing_measurements, "reject")
  assert.equal(packing.default_item_weight_grams, 500)
  assert.equal(courier.selection, "lowest_price")
  assert.equal(courier.require_real_time_tracking, false)
  assert.equal(defaults.enabled, false)
})
test("missing DB credentials or settings cannot be rescued by environment credentials or webhook secrets", async (t) => {
  hostileEnvironment(t)
  let preferences: any = {
    settings: defaultOperationalSettings(),
    revision: 1,
    updated_at: new Date(),
    webhook_token_ciphertext: null,
  }
  const db: any = (table: string) => ({
    where: () => ({
      first: async () =>
        table === "shiprocket_preferences" ? preferences : undefined,
    }),
  })
  const service = new Service({ manager: { getKnex: () => db } })
  assert.equal((await service.read()).configured, false)
  assert.equal((await service.runtimeSettings()).enabled, false)
  assert.equal(await service.webhookToken(), undefined)
  await assert.rejects(() => service.runtime(), /Configure and verify/)
  preferences = undefined
  await assert.rejects(() => service.preferences(), /migrations/)
  await assert.rejects(() => service.runtimeSettings(), /migrations/)
  preferences = { settings: { enabled: true } }
  await assert.rejects(() => service.runtimeSettings())
})
test("production plugin source only reads the deployment encryption/signing root from the environment", async () => {
  const base = pathToFileURL(process.cwd() + "/src/")
  async function walk(directory: URL) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.name === "tests") continue
      const file = new URL(
        item.name + (item.isDirectory() ? "/" : ""),
        directory
      )
      if (item.isDirectory()) await walk(file)
      else if (item.name.endsWith(".ts") || item.name.endsWith(".tsx")) {
        const source = await readFile(file, "utf8")
        for (const access of source.match(
          /process\.env(?:\.[\w$]+|\[[^\]]+\])?/g
        ) || [])
          assert.equal(access, "process.env.JWT_SECRET", file.pathname)
      }
    }
  }
  await walk(base)
})
