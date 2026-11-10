import test from "node:test"
import assert from "node:assert/strict"
import { shiprocketOrderApplicability } from "../shared/order-applicability"
function fixture(changes: any = {}) {
  const calls: any[] = []
  const providers = changes.providers ?? [
    { id: "shiprocket_shiprocket", is_enabled: true },
    { id: "manual_manual", is_enabled: true },
  ]
  const order = changes.order ?? {
    id: "order",
    status: "pending",
    items: [
      {
        id: "item",
        requires_shipping: true,
        quantity: 1,
        detail: { fulfilled_quantity: 0 },
        variant: { product: { shipping_profile: { id: "profile" } } },
      },
    ],
    shipping_methods: [
      {
        shipping_option_id: "option",
        data: { shiprocket_quote: { courier_company_id: 33 } },
      },
    ],
  }
  const options = changes.options ?? [
    {
      id: "option",
      provider_id: "shiprocket_shiprocket",
      shipping_profile_id: "profile",
    },
  ]
  const container = {
    resolve: (name: string) => {
      assert.equal(name, "query")
      return {
        graph: async (input: any) => {
          calls.push(input)
          return {
            data:
              input.entity === "fulfillment_provider"
                ? providers
                : input.entity === "order"
                  ? [order]
                  : options,
          }
        },
      }
    },
  }
  return { container, calls, order }
}
test("disabled or absent native providers hide widgets before loading any order or carrier data", async () => {
  for (const providers of [
    [],
    [{ id: "shiprocket_shiprocket", is_enabled: false }],
    [{ id: "manual_manual", is_enabled: true }],
  ]) {
    const f = fixture({ providers })
    assert.deepEqual(await shiprocketOrderApplicability(f.container, "order"), {
      enabled: false,
      shipping_option_ids: [],
    })
    assert.equal(f.calls.length, 1)
  }
})
test("enabled provider applies only to actual provider-linked shipping options with unfulfilled profile items", async () => {
  const f = fixture()
  assert.deepEqual(await shiprocketOrderApplicability(f.container, "order"), {
    enabled: true,
    shipping_option_ids: ["option"],
  })
  const manual = fixture({
    options: [
      {
        id: "option",
        provider_id: "manual_manual",
        shipping_profile_id: "profile",
      },
    ],
  })
  assert.deepEqual(
    (await shiprocketOrderApplicability(manual.container, "order"))
      .shipping_option_ids,
    []
  )
  const other = fixture({
    options: [
      {
        id: "option",
        provider_id: "shiprocket_shiprocket",
        shipping_profile_id: "other",
      },
    ],
  })
  assert.deepEqual(
    (await shiprocketOrderApplicability(other.container, "order"))
      .shipping_option_ids,
    []
  )
})
test("canceled, fully fulfilled, nonshipping and manual-only orders are inapplicable despite stale quote metadata", async () => {
  for (const change of ["cancel", "fulfilled", "nonshipping", "noquote"]) {
    const f = fixture()
    if (change === "cancel") f.order.status = "canceled"
    if (change === "fulfilled") f.order.items[0].detail.fulfilled_quantity = 1
    if (change === "nonshipping") f.order.items[0].requires_shipping = false
    if (change === "noquote") f.order.shipping_methods = []
    assert.deepEqual(
      (await shiprocketOrderApplicability(f.container, "order"))
        .shipping_option_ids,
      []
    )
  }
})
