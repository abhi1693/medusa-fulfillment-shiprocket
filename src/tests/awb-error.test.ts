import test from "node:test"
import assert from "node:assert/strict"
import { awbErrorDiagnostic, awbErrorSummary } from "../shared/awb-error"

test("preserves an unknown carrier rejection instead of reducing it to unclassified", () => {
  const message = "Carrier integration SR-WMS-42 cannot allocate a waybill"
  const result = awbErrorDiagnostic({
    awb_assign_status: 0,
    message: "Generic assignment failure",
    response: {
      message: "Generic response failure",
      data: { awb_assign_error: message },
    },
  })
  assert.ok(result.message?.startsWith(message))
})

test("preserves a carrier warehouse remark before generic messages and ignores boolean error flags", () => {
  const reason = "ClientWarehouse matching query does not exist."
  const result = awbErrorDiagnostic({
    awb_assign_status: 0,
    message: "Generic assignment failure",
    response: { data: { rmk: reason, error: true, success: false } },
  })
  assert.equal(result.message, `${reason}; Generic assignment failure`)
  const primary = awbErrorDiagnostic({
    response: {
      data: { awb_assign_error: "Specific carrier rejection", rmk: reason },
    },
  })
  assert.equal(primary.message, `Specific carrier rejection; ${reason}`)
})

test("carrier remarks use the same redaction and length bounds as other allowed errors", () => {
  const result = awbErrorDiagnostic(
    {
      response: {
        data: {
          rmk:
            "ClientWarehouse missing for Asha Fixture, buyer@example.test, 9876543210; password=fixture-secret " +
            "x".repeat(2000),
          unknown: "must-not-copy-unknown-payload",
        },
      },
    },
    ["Asha Fixture"]
  )
  assert.ok(result.message?.startsWith("ClientWarehouse missing"))
  assert.ok(result.message!.length <= 600)
  for (const secret of [
    "Asha Fixture",
    "buyer@example.test",
    "9876543210",
    "fixture-secret",
    "must-not-copy-unknown-payload",
  ])
    assert.ok(!JSON.stringify(result).includes(secret), secret)
})

test("extracts a plain response-data rejection without serializing object or array payloads", () => {
  assert.deepEqual(
    awbErrorDiagnostic({
      awb_assign_status: 0,
      response: { data: "Please contact support team" },
      no_pickup_popup: 0,
      quick_pick: 0,
    }),
    { message: "Please contact support team" }
  )
  for (const data of [{ unknown: "hidden-payload" }, ["hidden-payload"]])
    assert.deepEqual(awbErrorDiagnostic({ response: { data } }), {})
  const redacted = awbErrorDiagnostic({
    response: {
      data:
        "Please contact support team at buyer@example.test; password=fixture-secret " +
        "x".repeat(2000),
    },
  })
  assert.ok(redacted.message?.startsWith("Please contact support team"))
  assert.ok(redacted.message!.length <= 600)
  assert.ok(!redacted.message!.includes("buyer@example.test"))
  assert.ok(!redacted.message!.includes("fixture-secret"))
})

test("preserves seller action and provider status alongside the specific rejection", () => {
  const result = awbErrorDiagnostic({
    status_code: 350,
    response: {
      action_required: "Review the courier account configuration",
      data: { awb_assign_error: "Carrier account requires attention" },
    },
  })
  assert.equal(result.message, "Carrier account requires attention")
  assert.equal(
    result.action_required,
    "Review the courier account configuration"
  )
  assert.equal(result.status_code, 350)
  const summary = awbErrorSummary(result)
  assert.ok(summary.includes(result.message))
  assert.ok(summary.includes(result.action_required))
  assert.ok(summary.includes("350"))
})

for (const [name, body] of [
  ["top-level message", { message: "Carrier rejected this assignment" }],
  ["top-level error", { error: "Carrier rejected this assignment" }],
  [
    "response message",
    { response: { message: "Carrier rejected this assignment" } },
  ],
  [
    "response error",
    { response: { error: "Carrier rejected this assignment" } },
  ],
  [
    "response-data message",
    { response: { data: { message: "Carrier rejected this assignment" } } },
  ],
  [
    "response-data error",
    { response: { data: { error: "Carrier rejected this assignment" } } },
  ],
] as const)
  test(`extracts a documented ${name} fallback`, () => {
    assert.equal(
      awbErrorDiagnostic(body).message,
      "Carrier rejected this assignment"
    )
  })

test("extracts an HTTP rejection body without copying transport headers or request configuration", () => {
  const transport = {
    response: {
      status: 422,
      headers: { authorization: "transport-header-secret" },
      data: {
        message: "The selected service cannot assign this shipment",
        action_required: "Choose a supported service",
        status_code: "422",
      },
    },
    config: { headers: { authorization: "request-header-secret" } },
  }
  // The caller passes Axios response.data, never the complete Axios error.
  const result = awbErrorDiagnostic(transport.response.data)
  assert.equal(
    result.message,
    "The selected service cannot assign this shipment"
  )
  assert.equal(result.action_required, "Choose a supported service")
  assert.equal(result.status_code, "422")
  assert.ok(!JSON.stringify(result).includes("transport-header-secret"))
  assert.ok(!JSON.stringify(result).includes("request-header-secret"))
})

test("ignores malformed fields and never stringifies arbitrary objects or unknown body fields", () => {
  const opaque = {
    toString() {
      throw Error("must not stringify response objects")
    },
  }
  for (const body of [
    undefined,
    null,
    false,
    42,
    "opaque response text",
    [],
    {
      message: opaque,
      error: ["arbitrary-array-value"],
      action_required: opaque,
      status_code: opaque,
      headers: { authorization: "hidden-header-value" },
      customer: { email: "hidden-buyer@example.test" },
      response: { data: { awb_assign_error: opaque } },
    },
  ]) {
    assert.deepEqual(awbErrorDiagnostic(body), {})
  }
})

test("empty or non-string primary fields do not hide an available string fallback", () => {
  for (const value of ["", "   ", null, 0, false, {}, []]) {
    const result = awbErrorDiagnostic({
      message: "A useful carrier error",
      response: { data: { awb_assign_error: value } },
    })
    assert.equal(result.message, "A useful carrier error")
  }
})

test("redacts contact details, transport credentials and URLs while retaining the actual diagnostic", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.aFixtureSignature_0123456789"
  const message = [
    "Carrier SR-WMS-42 rejected assignment",
    "buyer@example.test",
    "+91 98765 43210",
    "9876543210",
    "https://carrier.example.test/assign?token=url-fixture-secret",
    "Bearer fixture-bearer-token",
    "api_key=fixture-api-secret",
    "password: fixture-password",
    "token=fixture-token",
    jwt,
  ].join("; ")
  const result = awbErrorDiagnostic({
    response: { data: { awb_assign_error: message } },
  })
  assert.ok(result.message?.includes("Carrier SR-WMS-42 rejected assignment"))
  const serialized = JSON.stringify(result)
  for (const value of [
    "buyer@example.test",
    "98765",
    "43210",
    "9876543210",
    "https://carrier.example.test",
    "url-fixture-secret",
    "fixture-bearer-token",
    "fixture-api-secret",
    "fixture-password",
    "fixture-token",
    jwt,
  ])
    assert.ok(!serialized.includes(value), `must redact ${value}`)
})

test("redacts caller-supplied buyer names, addresses and connection credentials in both diagnostic fields", () => {
  const buyer = "Asha Fixture"
  const address = "17 Fixture Road"
  const credential = "fixture-connection-credential"
  const result = awbErrorDiagnostic(
    {
      response: {
        action_required: `Review ASHA FIXTURE at ${address}; credential ${credential}`,
        data: {
          awb_assign_error: `Carrier could not process ${buyer} at ${address}; credential ${credential}`,
        },
      },
    },
    [buyer, address, credential, undefined, null]
  )
  const serialized = JSON.stringify(result).toLowerCase()
  for (const value of [buyer, address, credential]) {
    assert.ok(!serialized.includes(value.toLowerCase()), `must redact ${value}`)
  }
  assert.ok(result.message?.includes("Carrier could not process"))
  assert.ok(result.action_required?.includes("Review"))
})

test("normalizes control characters and bounds provider-controlled diagnostic lengths", () => {
  const result = awbErrorDiagnostic({
    message: "Carrier rejection\n\r\t\u0000\u001b" + "m".repeat(2000),
    action_required: "Review account\n\r\t\u0000\u001b" + "a".repeat(700),
  })
  assert.ok(result.message)
  assert.ok(result.action_required)
  assert.ok(result.message.startsWith("Carrier rejection"))
  assert.ok(result.action_required.startsWith("Review account"))
  assert.ok(result.message.length <= 1000)
  assert.ok(result.action_required.length <= 300)
  assert.ok(!/[\u0000-\u001f\u007f]/.test(result.message))
  assert.ok(!/[\u0000-\u001f\u007f]/.test(result.action_required))
})
