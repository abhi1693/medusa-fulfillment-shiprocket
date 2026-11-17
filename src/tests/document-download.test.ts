import test from "node:test"
import assert from "node:assert/strict"
import { checkDocument } from "../shared/document-download"
const url = "https://sr-core-cdn-stage.kartrocket.com/fixture.pdf"
test("carrier CDN403 is not a successful document and no API credentials are forwarded", async (t) => {
  const calls: any[] = []
  t.mock.method(globalThis, "fetch", async (...args: any[]) => {
    calls.push(args)
    return new Response("Denied", { status: 403 })
  })
  const result = await checkDocument(url, 60000)
  assert.equal(result.available, false)
  assert.equal(result.http_status, 403)
  assert.match(result.message, /HTTP 403/)
  assert.equal(calls[0][1].headers, undefined)
  assert.ok(calls[0][1].signal instanceof AbortSignal)
})
test("PDF bytes are checked and HTML success is rejected", async (t) => {
  let content = "%PDF-fixture"
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(content, { status: 200 })
  )
  assert.equal((await checkDocument(url, 60000)).available, true)
  content = "<html>Denied</html>"
  assert.equal((await checkDocument(url, 60000)).available, false)
})
test("document redirects cannot reach arbitrary hosts or forward credentials", async (t) => {
  let requests = 0
  t.mock.method(globalThis, "fetch", async () => {
    requests++
    return new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/" },
    })
  })
  assert.equal((await checkDocument(url, 60000)).available, false)
  assert.equal(requests, 1)
  for (const target of [
    "http://sr-core-cdn-stage.kartrocket.com/file",
    "https://example.test/file",
    "https://user:password@sr-core-cdn-stage.kartrocket.com/file",
  ])
    assert.equal((await checkDocument(target, 60000)).available, false)
  assert.equal(requests, 1)
})
