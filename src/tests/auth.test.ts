import type { ShiprocketClientOptions } from "../providers/shiprocket/client/types"
import test from "node:test"
import assert from "node:assert/strict"
import axios, { AxiosError } from "axios"
import {
  getShiprocketManager,
  resetShiprocketManager,
} from "../providers/shiprocket/client/manager"

const options = {
  email: "api@example.test",
  password: "fixture-password",
  mode: "test" as const,
}
function response(config: any, data: any, status = 200): any {
  return { config, data, status, statusText: String(status), headers: {} }
}
function setup(t: any, adapter: any, overrides: ShiprocketClientOptions = {}) {
  const previous = axios.defaults.adapter
  axios.defaults.adapter = adapter
  resetShiprocketManager()
  const logs: string[] = []
  const logger = {
    debug: (value: string) => logs.push(value),
    info: (value: string) => logs.push(value),
    warn: (value: string) => logs.push(value),
    error: (value: string) => logs.push(value),
  } as any
  t.after(() => {
    axios.defaults.adapter = previous
    resetShiprocketManager()
  })
  return {
    manager: getShiprocketManager(logger, { ...options, ...overrides }),
    logs,
  }
}
test("credential login is JSON without stale bearer credentials, then token is cached privately", async (t) => {
  let logins = 0
  const requests: any[] = []
  const f = setup(t, async (config: any) => {
    requests.push(config)
    if (config.url === "/auth/login") {
      logins++
      assert.deepEqual(JSON.parse(config.data), {
        email: options.email,
        password: options.password,
      })
      assert.equal(config.headers.get("Content-Type"), "application/json")
      assert.equal(config.headers.get("Authorization"), undefined)
      return response(config, { token: "fixture-generated-token" })
    }
    assert.equal(
      config.headers.get("Authorization"),
      "Bearer fixture-generated-token"
    )
    return response(config, { data: { shipping_address: [] } })
  })
  const api = await f.manager.getAxios()
  await api.get("/settings/company/pickup")
  await f.manager.getAxios()
  assert.equal(logins, 1)
  for (const secret of [
    options.email,
    options.password,
    "fixture-generated-token",
  ])
    assert.equal(f.logs.join("").includes(secret), false)
  assert.ok(
    requests.every(
      (config) =>
        config.baseURL === "https://api-sandbox.shiprocket.in/v1/external"
    )
  )
})
test("concurrent requests share one proactive token refresh after expiry", async (t) => {
  let now = Date.now()
  t.mock.method(Date, "now", () => now)
  let logins = 0
  const f = setup(t, async (config: any) => {
    logins++
    return response(config, { token: "fixture-generated-" + logins })
  })
  await Promise.all([
    f.manager.getAxios(),
    f.manager.getAxios(),
    f.manager.getAxios(),
  ])
  assert.equal(logins, 1)
  now += 9 * 24 * 60 * 60 * 1000
  await Promise.all([f.manager.getAxios(), f.manager.getAxios()])
  assert.equal(logins, 2)
})
test("401 refreshes credentials once and retries with the newly generated token", async (t) => {
  let logins = 0,
    gets = 0
  const f = setup(t, async (config: any) => {
    if (config.url === "/auth/login")
      return response(config, { token: "fixture-generated-" + ++logins })
    gets++
    if (gets === 1)
      throw new AxiosError(
        "Fixture unauthorized",
        "ERR_BAD_REQUEST",
        config,
        undefined,
        response(config, {}, 401)
      )
    assert.equal(
      config.headers.get("Authorization"),
      "Bearer fixture-generated-2"
    )
    return response(config, { ok: true })
  })
  const api = await f.manager.getAxios()
  await api.get("/settings/company/pickup")
  assert.equal(logins, 2)
  assert.equal(gets, 2)
})
test("repeated 401 terminates rather than refreshing forever", async (t) => {
  let logins = 0,
    gets = 0
  const f = setup(t, async (config: any) => {
    if (config.url === "/auth/login")
      return response(config, { token: "fixture-generated-" + ++logins })
    gets++
    throw new AxiosError(
      "Fixture unauthorized",
      "ERR_BAD_REQUEST",
      config,
      undefined,
      response(config, {}, 401)
    )
  })
  const api = await f.manager.getAxios()
  await assert.rejects(api.get("/settings/company/pickup"))
  assert.equal(logins, 2)
  assert.equal(gets, 2)
})
test("failed or tokenless login does not cache a fabricated token or burst retries", async (t) => {
  let logins = 0
  const f = setup(t, async (config: any) => {
    logins++
    return response(config, {})
  })
  await assert.rejects(f.manager.getAxios(), /no token/)
  await assert.rejects(f.manager.getAxios(), /retry is delayed/)
  assert.equal(logins, 1)
  assert.equal(f.manager.getTokenExpiry(), null)
})

test("429 honors Retry-After without repeatedly calling login", async (t) => {
  let now = Date.now()
  t.mock.method(Date, "now", () => now)
  let logins = 0
  const f = setup(t, async (config: any) => {
    logins++
    if (logins === 1)
      throw new AxiosError(
        "Fixture rate limit",
        "ERR_BAD_REQUEST",
        config,
        undefined,
        { ...response(config, {}, 429), headers: { "retry-after": "30" } }
      )
    return response(config, { token: "fixture-generated-recovered" })
  })
  await assert.rejects(f.manager.getAxios())
  now += 29000
  await assert.rejects(f.manager.getAxios(), /retry is delayed/)
  assert.equal(logins, 1)
  now += 1001
  await f.manager.getAxios()
  assert.equal(logins, 2)
})
test("late 401 for an older token reuses an already refreshed token", async (t) => {
  let logins = 0
  const f = setup(t, async (config: any) => {
    if (config.url === "/auth/login")
      return response(config, { token: "fixture-generated-" + ++logins })
    if (!config._retry)
      throw new AxiosError(
        "Fixture old token",
        "ERR_BAD_REQUEST",
        config,
        undefined,
        response(config, {}, 401)
      )
    return response(config, { ok: true })
  })
  const api = await f.manager.getAxios()
  await api.get("/settings/company/pickup")
  await api.get("/settings/company/pickup", {
    headers: { Authorization: "Bearer fixture-generated-1" },
  })
  assert.equal(logins, 2)
})

test("test mode login sends only the sandbox browser headers and generates its API bearer", async (t) => {
  let logins = 0,
    reads = 0
  const f = setup(
    t,
    async (config: any) => {
      assert.equal(
        config.baseURL,
        "https://api-sandbox.shiprocket.in/v1/external"
      )
      assert.equal(
        config.headers.get("Origin"),
        "https://sandbox.shiprocket.in"
      )
      assert.equal(
        config.headers.get("Referer"),
        "https://sandbox.shiprocket.in"
      )
      if (config.url === "/auth/login") {
        logins++
        assert.equal(config.headers.get("Authorization"), undefined)
        assert.deepEqual(JSON.parse(config.data), {
          email: options.email,
          password: options.password,
        })
        return response(config, { token: "fixture-generated-test-token" })
      }
      reads++
      assert.equal(
        config.headers.get("Authorization"),
        "Bearer fixture-generated-test-token"
      )
      return response(config, {})
    },
    { mode: "test" }
  )
  const api = await f.manager.getAxios()
  await api.get("/settings/company/pickup")
  assert.equal(logins, 1)
  assert.equal(reads, 1)
})
test("sandbox browser headers are absent outside test mode", async (t) => {
  let logins = 0
  const f = setup(
    t,
    async (config: any) => {
      assert.equal(config.baseURL, "https://apiv2.shiprocket.in/v1/external")
      assert.equal(config.headers.get("Origin"), undefined)
      assert.equal(config.headers.get("Referer"), undefined)
      if (config.url === "/auth/login") {
        logins++
        assert.equal(config.headers.get("Authorization"), undefined)
        return response(config, { token: "fixture-generated-ordinary-token" })
      }
      assert.equal(
        config.headers.get("Authorization"),
        "Bearer fixture-generated-ordinary-token"
      )
      return response(config, {})
    },
    { mode: "live" }
  )
  const api = await f.manager.getAxios()
  await api.get("/settings/company/pickup")
  assert.equal(logins, 1)
})

test("fulfillment HTTP timings identify endpoint and failure without logging payload or bearer", async (t) => {
  const f = setup(t, async (config: any) => {
    if (config.url === "/auth/login")
      return response(config, { token: "private-fixture-token" })
    if (config.url.includes("assign/awb"))
      throw new AxiosError("private-personal-message", "ECONNABORTED", config)
    return response(config, { order_id: 1, shipment_id: 2 })
  })
  const api = await f.manager.getAxios(),
    config: any = { shiprocket_order_id: "order_fixture" }
  await api.post(
    "/orders/create/adhoc",
    {
      billing_email: "private@example.test",
      shipping_address: "Private fixture address",
    },
    config
  )
  await assert.rejects(
    api.post("/courier/assign/awb?phone=9876543210", { shipment_id: 2 }, config)
  )
  const records = f.logs
    .filter((line) => line.startsWith("Shiprocket HTTP "))
    .map((line) => JSON.parse(line.slice("Shiprocket HTTP ".length)))
  assert.ok(
    records.some(
      (r) =>
        r.phase === "success" &&
        r.endpoint === "/orders/create/adhoc" &&
        r.status === 200
    )
  )
  assert.ok(
    records.some(
      (r) =>
        r.phase === "error" &&
        r.endpoint === "/courier/assign/awb" &&
        r.code === "ECONNABORTED" &&
        typeof r.duration_ms === "number"
    )
  )
  for (const value of [
    "private@example.test",
    "Private fixture address",
    "private-fixture-token",
    "9876543210",
    "private-personal-message",
    options.password,
  ])
    assert.equal(f.logs.join(" ").includes(value), false)
})

test("explicit timeout is honored and isolated from the cached default client", async (t) => {
  const f = setup(
    t,
    async (config: any) => response(config, { token: "fixture-token" }),
    { timeout: 60000 }
  )
  const slow = await f.manager.getAxios()
  assert.equal(slow.defaults.timeout, 60000)
  const short = await getShiprocketManager(undefined, {
    ...options,
    timeout: 15000,
  }).getAxios()
  assert.equal(short.defaults.timeout, 15000)
  assert.notEqual(slow, short)
  for (const timeout of [0, -1, NaN, Infinity, 60001, 1000.5])
    assert.throws(
      () => getShiprocketManager(undefined, { ...options, timeout }),
      /timeout must be/
    )
})
