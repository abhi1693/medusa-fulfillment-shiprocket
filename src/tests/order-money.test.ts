import { BigNumber } from "@medusajs/framework/utils"
import test from "node:test"
import assert from "node:assert/strict"
import {
  shiprocketOrderMoney,
  moneyPaise,
  stableFulfillmentReference,
  type FulfillmentFinancials,
} from "../shared/order-money"
const line = (
  id: string,
  gross: number,
  net: number,
  quantity = 1,
  fulfilled_quantity = 0,
  tax = 0,
  rate = 0
) => ({
  id,
  quantity,
  fulfilled_quantity,
  original_total: gross,
  total: net,
  tax_total: tax,
  original_tax_total: tax,
  tax_rates: rate ? [rate] : [],
})
const fixture = (): FulfillmentFinancials => ({
  currency_code: "inr",
  shipping_total: 400,
  shipping_tax_total: 0,
  lines: [line("a", 12900, 9030), line("b", 59900, 41930)],
  selected_items: [
    { id: "a", quantity: 1 },
    { id: "b", quantity: 1 },
  ],
})
test("Medusa v2 major units preserve the synthetic 100x regression, discount and shipping", () => {
  const result = shiprocketOrderMoney(fixture())
  assert.deepEqual(
    result.items.map((item) => [item.selling_price, item.discount]),
    [
      [12900, 3870],
      [59900, 17970],
    ]
  )
  assert.equal(result.total_discount, 21840)
  assert.equal(result.shipping_charges, 400)
  assert.equal(result.sub_total, 72800)
  assert.equal(result.order_total, 51360)
  assert.equal(result.summary.goods_total, 50960)
})
test("partial shipments allocate one shared customer shipping charge without duplication", () => {
  const full = fixture(),
    a = shiprocketOrderMoney({
      ...full,
      selected_items: [{ id: "a", quantity: 1 }],
    }),
    b = shiprocketOrderMoney({
      ...full,
      selected_items: [{ id: "b", quantity: 1 }],
    })
  assert.equal(a.shipping_charges, 70.87)
  assert.equal(b.shipping_charges, 329.13)
  assert.equal(
    moneyPaise(a.sub_total) + moneyPaise(b.sub_total),
    moneyPaise(72800)
  )
  assert.equal(
    moneyPaise(a.order_total) + moneyPaise(b.order_total),
    moneyPaise(51360)
  )
  assert.equal(a.total_discount + b.total_discount, 21840)
})
test("tax-inclusive native gross and net totals avoid adding GST twice and conserve partial paise", () => {
  const source: FulfillmentFinancials = {
    currency_code: "inr",
    shipping_total: 100,
    shipping_tax_total: 0,
    lines: [
      { ...line("taxed", 354, 330.4, 3, 0, 50.4, 18), original_tax_total: 54 },
    ],
    selected_items: [{ id: "taxed", quantity: 3 }],
  }
  const full = shiprocketOrderMoney(source)
  assert.equal(full.items[0].selling_price, 118)
  assert.equal(full.total_discount, 23.6)
  assert.equal(full.summary.tax_total, 50.4)
  assert.equal(full.sub_total, 354)
  assert.equal(full.order_total, 430.4)
  const parts = [0, 1, 2].map((done) =>
    shiprocketOrderMoney({
      ...source,
      lines: [{ ...source.lines[0], fulfilled_quantity: done }],
      selected_items: [{ id: "taxed", quantity: 1 }],
    })
  )
  for (const key of [
    "sub_total",
    "order_total",
    "shipping_charges",
    "total_discount",
  ] as const)
    assert.equal(
      parts.reduce((sum, p) => sum + moneyPaise(p[key]), 0n),
      moneyPaise(full[key])
    )
  assert.equal(
    parts.reduce((sum, p) => sum + moneyPaise(p.summary.tax_total), 0n),
    5040n
  )
})
test("decimal rupees retain paise and zero-value goods allocate shipping by quantity", () => {
  assert.equal(moneyPaise("12900.99"), 1290099n)
  const result = shiprocketOrderMoney({
    currency_code: "inr",
    shipping_total: 0.01,
    shipping_tax_total: 0,
    lines: [line("a", 0, 0), line("b", 0, 0)],
    selected_items: [
      { id: "a", quantity: 1 },
      { id: "b", quantity: 1 },
    ],
  })
  assert.equal(result.sub_total, 0)
  assert.equal(result.order_total, 0.01)
  assert.equal(
    shiprocketOrderMoney({
      currency_code: "inr",
      shipping_total: 0,
      lines: [line("a", 19.99, 17.49)],
      selected_items: [{ id: "a", quantity: 1 }],
    }).sub_total,
    19.99
  )
})
test("invalid, ambiguous or unsupported financial inputs fail before any remote operation", () => {
  for (const input of [
    { ...fixture(), currency_code: "usd" },
    { ...fixture(), selected_items: [{ id: "other", quantity: 1 }] },
    { ...fixture(), selected_items: [{ id: "a", quantity: 2 }] },
    { ...fixture(), lines: [line("a", 1, 1, 3)] },
    { ...fixture(), shipping_total: undefined },
    {
      ...fixture(),
      selected_items: [
        { id: "a", quantity: 1 },
        { id: "a", quantity: 1 },
      ],
    },
  ])
    assert.throws(() => shiprocketOrderMoney(input as any))
})
test("unchanged fulfillment retries use the same <=50 character reference; subsequent quantities get a new one", () => {
  const source = fixture(),
    ref = stableFulfillmentReference("order", "option", source)
  assert.equal(
    ref,
    stableFulfillmentReference("order", "option", {
      ...source,
      selected_items: [...source.selected_items].reverse(),
    })
  )
  assert.ok(ref.length <= 50)
  assert.notEqual(
    ref,
    stableFulfillmentReference("order", "option", {
      ...source,
      lines: source.lines.map((l) => ({ ...l, fulfilled_quantity: 1 })),
    })
  )
})

test("shipping tax is already included in the charged shipping amount and allocated once", () => {
  const result = shiprocketOrderMoney({
    currency_code: "inr",
    shipping_total: 118,
    shipping_tax_total: 18,
    lines: [
      { ...line("a", 118, 94.4, 1, 0, 14.4, 18), original_tax_total: 18 },
    ],
    selected_items: [{ id: "a", quantity: 1 }],
  })
  assert.equal(result.sub_total, 118)
  assert.equal(result.order_total, 212.4)
  assert.equal(result.shipping_charges, 118)
  assert.equal(result.summary.tax_total, 32.4)
})

test("native Medusa BigNumber values preserve exact paise", () => {
  assert.equal(moneyPaise(new BigNumber("354.00")), 35400n)
  assert.equal(moneyPaise(new BigNumber("330.40")), 33040n)
  assert.equal(moneyPaise(new BigNumber("0.005")), 1n)
})

test("observed Shiprocket arithmetic applies discount and shipping once to gross subtotal", () => {
  const result = shiprocketOrderMoney({
    currency_code: "inr",
    shipping_total: 100,
    shipping_tax_total: 0,
    lines: [line("a", 12900, 9030), line("b", 42900, 30030)],
    selected_items: [
      { id: "a", quantity: 1 },
      { id: "b", quantity: 1 },
    ],
  })
  assert.equal(result.sub_total, 55800)
  assert.equal(result.total_discount, 16740)
  assert.equal(result.order_total, 39160)
  assert.equal(
    result.sub_total - result.total_discount + result.shipping_charges,
    result.order_total
  )
})
