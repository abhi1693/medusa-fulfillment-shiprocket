import { errorHandler } from "@medusajs/framework/http"
import test from "node:test"
import assert from "node:assert/strict"
import {
  allocateShipments,
  scopedShipmentContext,
  shipmentLineKey,
} from "../shared/cart-shipment-plan"
import { orderShipmentAllocation } from "../shared/order-shipment-allocation"
// Exercise the public native HTTP boundary used by the Admin fulfillment form.
const validationResponse = (message: RegExp) => (error: unknown) => {
  let statusCode = 0
  let body: any
  errorHandler()(
    error,
    { scope: { resolve: () => ({ info() {}, error() {} }) } } as any,
    {
      status(code: number) {
        statusCode = code
        return this
      },
      json(value: any) {
        body = value
      },
    } as any,
    () => {}
  )
  assert.equal(statusCode, 400)
  assert.equal(body.type, "invalid_data")
  assert.match(body.message, message)
  return true
}
const option = (id: string, location: string) => ({
  id,
  shipping_profile_id: "profile",
  provider_id: "shiprocket_shiprocket",
  service_zone: { fulfillment_set: { location: { id: location } } },
})
const item = (id: string, stock: Record<string, number>, quantity = 1) => ({
  id,
  variant_id: "variant_" + id,
  unit_price: 100,
  quantity,
  product: { shipping_profile: { id: "profile" } },
  variant: {
    manage_inventory: true,
    inventory_items: [
      {
        inventory_item_id: "inv_" + id,
        required_quantity: 1,
        inventory: {
          requires_shipping: true,
          location_levels: Object.entries(stock).map(
            ([location_id, available_quantity]) => ({
              location_id,
              available_quantity,
            })
          ),
        },
      },
    ],
  },
})
const options = [option("office", "office"), option("warehouse", "warehouse")]
test("keeps ordinary delivery when any single origin can supply the complete cart", () => {
  assert.deepEqual(
    allocateShipments(
      [
        item("a", { office: 2, warehouse: 1 }),
        item("b", { office: 1, warehouse: 0 }),
      ],
      options,
      "cart"
    ),
    {}
  )
})
test("allocates disjoint stock to two origins with a shared immutable plan", () => {
  const a = item("a", { office: 1, warehouse: 0 }),
    b = item("b", { office: 0, warehouse: 1 })
  const plan = allocateShipments([b, a], options, "cart")
  assert.equal(plan.office.plan_id, plan.warehouse.plan_id)
  assert.equal(plan.office.groups.length, 2)
  assert.deepEqual(plan.office.cart_items, [{ id: "a", quantity: 1 }])
  assert.deepEqual(plan.warehouse.cart_items, [{ id: "b", quantity: 1 }])
  assert.equal(plan.office.items[0].key, shipmentLineKey(a))
  assert.deepEqual(
    plan,
    allocateShipments([a, b], [...options].reverse(), "cart")
  )
  const context = {
    from_location: { id: "office" },
    items: [a, b],
    shiprocket_shipment_allocations: plan,
  }
  assert.deepEqual(
    scopedShipmentContext(context, "office").items.map((i: any) => i.id),
    ["a"]
  )
  assert.throws(
    () =>
      scopedShipmentContext(
        { ...context, from_location: { id: "wrong" } },
        "office"
      ),
    /origin changed/
  )
  assert.throws(
    () => scopedShipmentContext({ ...context, items: [] }, "office"),
    /quantities changed/
  )
})
test("splits requested quantities and respects component quantities and reservations", () => {
  const a = item("a", { office: 2, warehouse: 1 }, 3)
  const plan = allocateShipments([a], options, "cart")
  assert.deepEqual(
    [plan.office.cart_items[0].quantity, plan.warehouse.cart_items[0].quantity],
    [2, 1]
  )
  a.variant.inventory_items[0].required_quantity = 2
  assert.throws(
    () => allocateShipments([a], options, "cart"),
    /cannot be allocated/
  )
})
test("shared inventory components are not double allocated", () => {
  const a = item("a", { office: 1, warehouse: 1 }),
    b = item("b", { office: 1, warehouse: 1 })
  b.variant.inventory_items[0].inventory_item_id = "inv_a"
  const plan = allocateShipments([a, b], options, "cart")
  assert.equal(plan.office.cart_items.length, 1)
  assert.equal(plan.warehouse.cart_items.length, 1)
})
test("unmanaged and backorder items keep native eligibility; unrelated providers are excluded", () => {
  const a = item("a", {})
  a.variant.manage_inventory = false
  assert.deepEqual(allocateShipments([a], options, "cart"), {})
  assert.deepEqual(
    allocateShipments(
      [item("a", {})],
      [{ ...options[0], provider_id: "manual_manual" }],
      "cart"
    ),
    {}
  )
  assert.throws(
    () => allocateShipments([item("a", {})], options, "cart"),
    /cannot be allocated/
  )
})
import { signCourierQuote } from "../shared/courier-quote"
import { courierPolicy } from "../providers/shiprocket/utils/courier-policy"
import { financialSnapshot, shiprocketOrderMoney } from "../shared/order-money"
test("persisted allocations bind warehouse quantities and bill each shipment's full charge, including later partial fulfillment", (t) => {
  const old = process.env.JWT_SECRET
  process.env.JWT_SECRET = "isolated-shipment-signing-secret-at-least-32-chars"
  t.after(() => {
    if (old === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = old
  })
  const cartLine = item("a", { office: 2, warehouse: 1 }, 3)
  const plan = allocateShipments([cartLine], options, "cart")
  const policy = courierPolicy()
  const methods = options.map((o) => ({
    shipping_option_id: o.id,
    total: 100,
    tax_total: 0,
    data: {
      shiprocket_quote: signCourierQuote(
        {
          courier_company_id: 1,
          courier_name: "Fixture",
          amount: 80,
          service: "surface",
          rating: 4,
          estimated_delivery_days: "3",
          estimated_delivery_date: null,
          realtime_tracking: true,
          call_before_delivery: true,
          pod: null,
          relaxed_preferences: [],
          quoted_at: new Date().toISOString(),
          policy,
        },
        {
          pickup_postcode: "122001",
          delivery_postcode: "110001",
          weight: 1,
          cod: 0,
        },
        {
          id: "cart",
          currency_code: "inr",
          items: [cartLine],
          shiprocket_quote_cart_fingerprint: "cart",
          shiprocket_quote_option_id: o.id,
          shiprocket_quote_account_scope: "account",
          from_location: { id: o.id },
          shiprocket_shipment_allocation: plan[o.id],
        }
      ),
    },
  }))
  const order: any = {
    currency_code: "inr",
    shipping_methods: methods,
    fulfillments: [],
    items: [
      {
        ...cartLine,
        id: "order_line",
        requires_shipping: true,
        original_total: 300,
        total: 270,
        tax_total: 0,
        original_tax_total: 0,
        tax_lines: [],
        detail: { fulfilled_quantity: 0 },
      },
    ],
  }
  const office = orderShipmentAllocation(order, "office", [
    { id: "order_line", quantity: 2 },
  ])!
  assert.equal(office[0].quantity, 2)
  assert.equal(office[0].total, 180)
  assert.throws(
    () =>
      orderShipmentAllocation(order, "warehouse", [
        { id: "order_line", quantity: 2 },
      ]),
    validationResponse(/exceed.*Deselect items assigned to other warehouses/)
  )
  const amounts = shiprocketOrderMoney(
    financialSnapshot({ ...order, items: office }, methods[0], [
      { id: "order_line", quantity: 2 },
    ])
  )
  assert.equal(amounts.shipping_charges, 100)
  order.items[0].detail.fulfilled_quantity = 2
  order.fulfillments = [
    {
      shipping_option_id: "office",
      items: [{ line_item_id: "order_line", quantity: 2 }],
    },
  ]
  const warehouse = orderShipmentAllocation(order, "warehouse", [
    { id: "order_line", quantity: 1 },
  ])!
  assert.equal(warehouse[0].quantity, 1)
  assert.equal(warehouse[0].detail.fulfilled_quantity, 0)
  assert.equal(warehouse[0].total, 90)
  assert.throws(
    () =>
      orderShipmentAllocation(
        { ...order, shipping_methods: [methods[0]] },
        "office",
        []
      ),
    validationResponse(/incomplete/)
  )
})
