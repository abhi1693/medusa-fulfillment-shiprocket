import { defaultOperationalSettings } from "../shared/operational-settings"
import test from "node:test"
import assert from "node:assert/strict"
import axios from "axios"
import Service, {
  sealPassword,
  openPassword,
} from "../modules/shiprocket-connection/service"
function setup(t: any) {
  const previous = process.env.JWT_SECRET,
    adapter = axios.defaults.adapter
  process.env.JWT_SECRET = "isolated-connection-test-key-at-least-32-characters"
  t.after(() => {
    if (previous === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = previous
    axios.defaults.adapter = adapter
  })
  let row: any = null
  const db: any = (table: string) => ({
    where: () => ({
      first: async () =>
        table === "shiprocket_connection"
          ? row
          : {
              settings: defaultOperationalSettings(),
              revision: 1,
              updated_at: new Date(),
              assignment_secret_ciphertext: sealPassword(
                process.env.JWT_SECRET!,
                "shiprocket-preferences:assignment"
              ),
            },
    }),
  })
  db.raw = async (_sql: string, values: any[]) => {
    if (row && row.revision !== values[5]) return { rows: [] }
    row = {
      id: "shiprocket",
      email: values[0],
      mode: values[1],
      password_ciphertext: values[2],
      revision: (row?.revision ?? 0) + 1,
      verified_at: values[3],
      updated_by: values[4],
    }
    return { rows: [{ id: "shiprocket" }] }
  }
  const requests: any[] = []
  axios.defaults.adapter = async (config: any) => {
    requests.push(config)
    return {
      data: { token: "private-token" },
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    }
  }
  return {
    service: new Service({ manager: { getKnex: () => db } }),
    requests,
    row: () => row,
  }
}
const input = {
  email: "api@example.test",
  password: "private-password",
  mode: "test" as const,
  revision: 0,
}
test("credentials require successful exact actor-bound verification, remain encrypted and never appear in detail", async (t) => {
  const { service, requests, row } = setup(t)
  assert.equal((await service.read()).configured, false)
  await assert.rejects(() =>
    service.save({ ...input, verification: "fake" }, "actor")
  )
  const proof = await service.verify(input, "actor")
  assert.equal(row(), null)
  assert.match(
    requests[0].url,
    /^https:\/\/api-sandbox.shiprocket.in\/.*auth\/login$/
  )
  assert.deepEqual(JSON.parse(requests[0].data), {
    email: input.email,
    password: input.password,
  })
  assert.equal(requests[0].timeout, 60000)
  await assert.rejects(() =>
    service.save({ ...input, verification: proof.verification }, "other")
  )
  await assert.rejects(() =>
    service.save(
      { ...input, mode: "live", verification: proof.verification },
      "actor"
    )
  )
  await assert.rejects(() =>
    service.save(
      { ...input, password: "changed", verification: proof.verification },
      "actor"
    )
  )
  await service.save({ ...input, verification: proof.verification }, "actor")
  assert.notEqual(row().password_ciphertext, input.password)
  assert.equal((await service.runtime()).password, input.password)
  assert.equal((await service.read()).revision, 1)
  assert.doesNotMatch(
    JSON.stringify(await service.read()),
    /password|ciphertext|private-token|verification/
  )
  await assert.rejects(() =>
    service.save({ ...input, verification: proof.verification }, "actor")
  )
})
test("only one concurrent verified save wins and mode changes use the live authentication endpoint", async (t) => {
  const { service, requests } = setup(t)
  const proof = await service.verify({ ...input, mode: "live" }, "actor")
  assert.match(requests[0].url, /^https:\/\/apiv2.shiprocket.in\//)
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      service.save(
        { ...input, mode: "live", verification: proof.verification },
        "actor"
      )
    )
  )
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1)
  assert.equal((await service.read()).revision, 1)
  const next = { ...input, password: "", revision: 1, mode: "live" as const }
  const check = await service.verify(next, "actor")
  await service.save({ ...next, verification: check.verification }, "actor")
  assert.equal((await service.runtime()).password, input.password)
})
test("login errors and tokenless responses cannot alter saved credentials or leak upstream errors", async (t) => {
  const { service } = setup(t),
    proof = await service.verify(input, "actor")
  await service.save({ ...input, verification: proof.verification }, "actor")
  for (const adapter of [
    async () => {
      throw Error("private-password")
    },
    async (config: any) => ({
      data: {},
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    }),
  ]) {
    axios.defaults.adapter = adapter as any
    await assert.rejects(
      () =>
        service.verify(
          { ...input, password: "new-password", revision: 1 },
          "actor"
        ),
      (error) => !String(error).includes("private-password")
    )
    assert.equal((await service.runtime()).password, input.password)
    assert.equal((await service.read()).revision, 1)
  }
})
test("encrypted passwords reject tampering and a changed encryption key", (t) => {
  setup(t)
  const value = sealPassword("secret")
  assert.equal(openPassword(value), "secret")
  assert.throws(() => openPassword(value + "changed"))
  process.env.JWT_SECRET =
    "different-test-encryption-key-at-least-32-characters"
  assert.throws(() => openPassword(value))
})

test("expired verification and invalid or extra credential fields cannot be saved", async (t) => {
  const { service } = setup(t)
  const proof = await service.verify(input, "actor")
  const now = Date.now()
  t.mock.method(Date, "now", () => now + 300001)
  await assert.rejects(() =>
    service.save({ ...input, verification: proof.verification }, "actor")
  )
  assert.equal((await service.read()).configured, false)
  await assert.rejects(() =>
    service.verify({ ...input, mode: "sandbox" } as any, "actor")
  )
  await assert.rejects(() =>
    service.verify({ ...input, id: "another" } as any, "actor")
  )
})
