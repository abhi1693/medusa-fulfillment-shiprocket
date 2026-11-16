import test from "node:test"
import assert from "node:assert/strict"
import { fulfillmentCourier } from "../shared/fulfillment-courier"

const binding = {
  shipping_option_id: "option",
  location_id: "office",
  scope: "account-test",
}
const paid = {
  courier_company_id: 51,
  courier_name: "Paid air",
  amount: 80,
  service: "air",
  quote_token: "immutable-paid-quote",
}
const override = {
  ...binding,
  courier_company_id: 170,
  courier_name: "Merchant surface",
  amount: 0,
  service: "surface",
}
const metadata = (choice: any) => ({
  shiprocket_fulfillment_couriers: { option: choice },
})
test("merchant service may change from air to surface without rewriting the paid quote", () => {
  const original = structuredClone(paid)
  const actual = fulfillmentCourier(metadata(override), binding, paid)
  assert.equal(actual.service, "surface")
  assert.equal(actual.courier_company_id, 170)
  assert.equal(actual.amount, 0)
  assert.deepEqual(paid, original)
  assert.equal(fulfillmentCourier({}, binding, paid), paid)
})
test("invalid saved merchant instructions cannot become signed fulfillment facts", () => {
  for (const choice of [
    null,
    false,
    [],
    { ...override, shipping_option_id: "other" },
    { ...override, location_id: "other" },
    { ...override, scope: "other" },
    { ...override, service: "rail" },
    { ...override, courier_company_id: 0 },
    { ...override, courier_company_id: 1.5 },
    { ...override, courier_company_id: "170" },
    { ...override, courier_name: " " },
    ...[-1, NaN, Infinity, "80", undefined].map((amount) => ({
      ...override,
      amount,
    })),
  ])
    assert.throws(
      () => fulfillmentCourier(metadata(choice), binding, paid),
      /merchant courier selection/
    )
})
test("package choices require their own method binding and do not inherit a legacy override", () => {
  const packageId = "a".repeat(64)
  const selected = { ...binding, package_id: packageId }
  assert.equal(fulfillmentCourier(metadata(override), selected, paid), paid)
  const choices = {
    ...metadata({ ...override, courier_company_id: 99 }),
    shiprocket_package_couriers: { [packageId]: override },
  }
  assert.equal(
    fulfillmentCourier(choices, selected, paid).courier_company_id,
    170
  )
  for (const value of [undefined, "other"]) {
    assert.throws(
      () =>
        fulfillmentCourier(
          {
            shiprocket_package_couriers: {
              [packageId]: { ...override, shipping_option_id: value },
            },
          },
          selected,
          paid
        ),
      /merchant courier selection/
    )
  }
})
