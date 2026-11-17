import axios from "axios"
import { readPickupCatalog } from "../shared/pickup-catalog"
import { resetShiprocketManager } from "../providers/shiprocket/client/manager"
import test from "node:test"
import assert from "node:assert/strict"
import { pickupScope } from "../shared/pickup-mapping"
import {
  readPickupMappings,
  changePickupMapping,
  pickupMappingRevision,
} from "../shared/pickup-location-mappings"
function fixture() {
  const connection = {
    email: "api@example.test",
    password: "fixture-password",
    mode: "test" as "test" | "live",
  }
  const scope = () =>
    pickupScope(
      connection.mode === "test"
        ? "https://api-sandbox.shiprocket.in/v1/external"
        : "https://apiv2.shiprocket.in/v1/external",
      connection.email
    )
  const rows: any[] = [
    {
      id: "sloc_a",
      name: "Office",
      updated_at: "2026-11-17T00:00:00Z",
      metadata: { private: "do-not-project", other: 42 },
      fulfillment_providers: [{ id: "shiprocket_shiprocket" }],
    },
    {
      id: "sloc_b",
      name: "Warehouse",
      metadata: {},
      fulfillment_providers: [],
    },
  ]
  const pickup = (id: string) => ({
    id,
    nickname: "Pickup " + id,
    address: "Road",
    address_2: "",
    city: "City",
    state: "State",
    country: "India",
    postcode: "110001",
  })
  const catalog = () => ({
    pickups: [pickup("101"), pickup("102")],
    scope: scope(),
    mode: connection.mode,
  })
  const reads: string[] = [],
    writes: any[] = [],
    locks: string[] = []
  let queue = Promise.resolve()
  const container = {
    resolve(key: string): any {
      if (key === "query")
        return {
          graph: async (input: any) => {
            reads.push(input.entity)
            assert.equal(input.entity, "stock_location")
            return {
              data: input.filters.id
                ? rows.filter((row) => row.id === input.filters.id)
                : rows,
            }
          },
        }
      if (key === "shiprocketConnection")
        return { runtime: async () => ({ ...connection }) }
      if (key === "locking")
        return {
          execute: async (key: string, fn: any) => {
            locks.push(key)
            const result = queue.then(fn)
            queue = result.catch(() => {})
            return result
          },
        }
      throw Error("Unexpected module " + key)
    },
  }
  const read = async () => catalog()
  const update = async (_c: any, input: any) => {
    writes.push(input)
    assert.deepEqual(Object.keys(input.update), ["metadata"])
    assert.deepEqual(Object.keys(input.update.metadata).sort(), [
      "shiprocket_pickup_id",
      "shiprocket_pickup_scope",
    ])
    const row = rows.find((row) => row.id === input.selector.id)
    row.metadata = { ...row.metadata, ...input.update.metadata }
  }
  const command = (
    action = "create",
    id = "sloc_a",
    pickup_id = "101"
  ): any => ({
    action,
    location_id: id,
    revision: pickupMappingRevision(rows.find((row) => row.id === id)),
    scope: scope(),
    ...(action !== "remove" ? { pickup_id } : {}),
  })
  return {
    container,
    connection,
    scope,
    rows,
    read,
    update,
    writes,
    reads,
    locks,
    command,
  }
}
test("catalog projects only public mapping fields and labels stale and unavailable addresses", async () => {
  const f = fixture()
  f.rows[0].metadata.shiprocket_pickup_id = "101"
  f.rows[0].metadata.shiprocket_pickup_scope = "old-account"
  f.rows[1].metadata.shiprocket_pickup_id = "999"
  const result = await readPickupMappings(f.container, f.read)
  assert.equal(result.locations[0].status, "different_connection")
  assert.equal(result.locations[1].status, "pickup_missing")
  assert.equal(result.locations[0].provider_linked, true)
  assert.doesNotMatch(
    JSON.stringify(result),
    /do-not-project|metadata|password/
  )
})
test("create, read, edit and remove change associations only, preserving all unrelated metadata", async () => {
  const f = fixture()
  await changePickupMapping(f.container, f.command(), f.read, f.update)
  assert.equal(
    (await readPickupMappings(f.container, f.read)).locations[0].status,
    "mapped"
  )
  await changePickupMapping(
    f.container,
    f.command("update", "sloc_a", "102"),
    f.read,
    f.update
  )
  assert.equal(f.rows[0].metadata.shiprocket_pickup_id, "102")
  await changePickupMapping(f.container, f.command("remove"), f.read, f.update)
  assert.deepEqual(f.rows[0].metadata, {
    private: "do-not-project",
    other: 42,
    shiprocket_pickup_id: null,
    shiprocket_pickup_scope: null,
  })
  assert.equal(f.rows.length, 2)
  assert.equal(f.writes.length, 3)
  assert.ok(f.locks.every((key) => key === "shiprocket:pickup-mapping:sloc_a"))
})
test("one pickup can map to multiple existing locations, but a location cannot be silently overwritten", async () => {
  const f = fixture()
  await changePickupMapping(f.container, f.command(), f.read, f.update)
  await changePickupMapping(
    f.container,
    f.command("create", "sloc_b"),
    f.read,
    f.update
  )
  assert.equal(
    f.rows[0].metadata.shiprocket_pickup_id,
    f.rows[1].metadata.shiprocket_pickup_id
  )
  await assert.rejects(
    () => changePickupMapping(f.container, f.command(), f.read, f.update),
    /changed/
  )
})
test("concurrent mappings and stale edits never overwrite a newer link", async () => {
  const f = fixture(),
    command = f.command()
  const results = await Promise.allSettled(
    ["101", "102"].map((pickup_id) =>
      changePickupMapping(
        f.container,
        { ...command, pickup_id },
        f.read,
        f.update
      )
    )
  )
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1)
  assert.equal(f.writes.length, 1)
  await assert.rejects(
    () =>
      changePickupMapping(
        f.container,
        { ...command, action: "update" },
        f.read,
        f.update
      ),
    /changed/
  )
})
test("scope changes before or during carrier read cannot write a mapping", async () => {
  const f = fixture(),
    command = f.command()
  f.connection.mode = "live"
  await assert.rejects(
    () => changePickupMapping(f.container, command, f.read, f.update),
    /changed/
  )
  f.connection.mode = "test"
  await assert.rejects(
    () =>
      changePickupMapping(
        f.container,
        command,
        async () => {
          const result = await f.read()
          f.connection.mode = "live"
          return result
        },
        f.update
      ),
    /changed/
  )
  assert.equal(f.writes.length, 0)
})
test("missing remote IDs, unknown local locations and failed lookups leave all associations unchanged", async () => {
  const f = fixture()
  await assert.rejects(
    () =>
      changePickupMapping(
        f.container,
        f.command("create", "sloc_a", "999"),
        f.read,
        f.update
      ),
    /no longer available/
  )
  await assert.rejects(
    () =>
      changePickupMapping(
        f.container,
        { ...f.command(), location_id: "missing" },
        f.read,
        f.update
      ),
    /not found/
  )
  await assert.rejects(
    () =>
      changePickupMapping(
        f.container,
        f.command(),
        async () => {
          throw Error("lookup failed")
        },
        f.update
      ),
    /lookup failed/
  )
  assert.equal(f.writes.length, 0)
})
test("removing a stale mapping needs no carrier write or catalog lookup", async () => {
  const f = fixture()
  f.rows[0].metadata.shiprocket_pickup_id = "gone"
  f.rows[0].metadata.shiprocket_pickup_scope = "old-account"
  await changePickupMapping(
    f.container,
    f.command("remove"),
    async () => {
      throw Error("must not call remote")
    },
    f.update
  )
  assert.equal(f.rows[0].metadata.shiprocket_pickup_id, null)
})
test("an interrupted update is retryable and action/create/delete payloads stay tightly bounded", async () => {
  const f = fixture(),
    command = f.command()
  await assert.rejects(
    () =>
      changePickupMapping(f.container, command, f.read, async () => {
        throw Error("workflow unavailable")
      }),
    /workflow unavailable/
  )
  assert.equal(f.rows[0].metadata.shiprocket_pickup_id, undefined)
  await changePickupMapping(f.container, command, f.read, f.update)
  for (const body of [
    { ...f.command("update"), address: "overwrite" },
    { ...f.command("remove"), pickup_id: "101" },
    { ...f.command("update"), action: "delete_location" },
    { ...f.command("update"), pickup_id: "../foreign" },
  ])
    await assert.rejects(() =>
      changePickupMapping(f.container, body, f.read, f.update)
    )
  assert.equal(f.rows.length, 2)
})

test("native mapping edits made during the carrier lookup are detected before writing", async () => {
  const f = fixture(),
    command = f.command()
  await assert.rejects(
    () =>
      changePickupMapping(
        f.container,
        command,
        async () => {
          f.rows[0].metadata.shiprocket_pickup_id = "102"
          return f.read()
        },
        f.update
      ),
    /changed/
  )
  assert.equal(f.writes.length, 0)
  assert.equal(f.rows[0].metadata.shiprocket_pickup_id, "102")
})

test("carrier catalog reads use the saved connection and expose no contact secrets or write endpoints", async (t) => {
  const adapter = axios.defaults.adapter
  resetShiprocketManager()
  t.after(() => {
    axios.defaults.adapter = adapter
    resetShiprocketManager()
  })
  const calls: string[] = []
  axios.defaults.adapter = async (config: any) => {
    calls.push(config.url)
    assert.equal(
      config.baseURL,
      "https://api-sandbox.shiprocket.in/v1/external"
    )
    const data =
      config.url === "/auth/login"
        ? { token: "private-token" }
        : config.url === "/settings/company/pickup"
          ? {
              data: {
                shipping_address: [
                  {
                    id: 101,
                    pickup_location: "Existing pickup",
                    address: "Road",
                    pin_code: 110001,
                    email: "private@example.test",
                    phone: "private-phone",
                    internal: "private-secret",
                  },
                  { id: -1 },
                  { id: Number.MAX_SAFE_INTEGER + 1 },
                ],
              },
            }
          : null
    assert.ok(data)
    return { config, data, status: 200, statusText: "OK", headers: {} }
  }
  const container = {
    resolve: (key: string) =>
      key === "shiprocketConnection"
        ? {
            runtime: async () => ({
              email: "api@example.test",
              password: "fixture-password",
              mode: "test" as const,
            }),
          }
        : { debug() {}, info() {}, warn() {}, error() {} },
  }
  const catalog = await readPickupCatalog(container)
  assert.equal(catalog.pickups.length, 1)
  assert.equal(catalog.pickups[0].id, "101")
  assert.doesNotMatch(JSON.stringify(catalog), /private|phone|password|token/)
  assert.deepEqual(calls, ["/auth/login", "/settings/company/pickup"])
})
