import { signedCourierClaim } from "../../shared/quote-integrity"
import { MedusaError } from "@medusajs/framework/utils"
import { cartShipmentPlan } from "../../shared/cart-shipment-plan"
import {
  shiprocketCartFingerprint,
  shiprocketPaymentPriceLocked,
  SHIPROCKET_CART_FINGERPRINT,
} from "../../shared/cart-shipping"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { StepResponse } from "@medusajs/framework/workflows-sdk"
import {
  addShippingMethodToCartWorkflow,
  calculateShippingOptionsPricesWorkflow,
  listShippingOptionsForCartWithPricingWorkflow,
} from "@medusajs/medusa/core-flows"
import { shiprocketItemMeasurements } from "../../providers/shiprocket/utils/quote"

// Medusa 2.22.4 projects all variant dimensions but only product.weight into its
// native pricing context. Enrich a namespaced per-line-item map through public
// hooks; framework-owned cart/items are deliberately left untouched.
async function shippingMeasurements(
  { input }: { input: { cart_id: string } },
  { container }: { container: MedusaContainer }
) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const {
    data: [cart],
  } = await query.graph({
    entity: "cart",
    filters: { id: input.cart_id },
    fields: [
      "id",
      "currency_code",
      "total",
      "payment_collection.payment_sessions.status",
      "payment_collection.payment_sessions.amount",
      "payment_collection.payment_sessions.currency_code",
      "shipping_methods.shipping_option_id",
      "shipping_methods.amount",
      "shipping_methods.is_tax_inclusive",
      "shipping_methods.data",
      "shipping_address.country_code",
      "shipping_address.postal_code",
      "items.variant_id",
      "items.product_id",
      "items.quantity",
      "items.id",
      "items.variant.weight",
      "items.variant.length",
      "items.variant.width",
      "items.variant.height",
      "items.product.weight",
      "items.product.length",
      "items.product.width",
      "items.product.height",
    ],
  })
  return new StepResponse({
    shiprocket_shipment_allocations: await cartShipmentPlan(
      container,
      input.cart_id
    ),
    shiprocket_payment_shipping_quotes: shiprocketPaymentPriceLocked(cart || {})
      ? Object.fromEntries(
          (cart?.shipping_methods || []).map((method: any) => [
            method.shipping_option_id,
            {
              quote: method.data?.shiprocket_quote,
              amount: method.amount,
              is_tax_inclusive: method.is_tax_inclusive,
              fingerprint: method.data?.[SHIPROCKET_CART_FINGERPRINT],
            },
          ])
        )
      : {},
    shiprocket_quote_cart_fingerprint: shiprocketCartFingerprint(cart),
    shiprocket_item_measurements: shiprocketItemMeasurements(cart?.items || []),
  })
}
calculateShippingOptionsPricesWorkflow.hooks.setCalculatedShippingPricingContext(
  shippingMeasurements
)
// Native shipping-method selection and cart refresh both call this workflow.
listShippingOptionsForCartWithPricingWorkflow.hooks.setCalculatedShippingPricingContext(
  shippingMeasurements
)

// Validate the complete server-derived allocation before native method writes.
addShippingMethodToCartWorkflow.hooks.validate(
  async ({ input }, { container }) => {
    const plan = await cartShipmentPlan(container, input.cart_id)
    const selected = (input.options || []).map((option) => ({
      id: option.id,
      quote: option.data?.shiprocket_quote as any,
    }))
    for (const option of selected) {
      const expected = plan[option.id]
      if (!expected) continue
      const claim = signedCourierClaim(option.quote)
      if (
        !expected.cart_items.length ||
        !claim ||
        JSON.stringify(claim.quote.shipment_allocation) !==
          JSON.stringify(expected)
      )
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Shipment allocation changed. Review delivery availability."
        )
      const groups = selected
        .map(
          (other) => signedCourierClaim(other.quote)?.quote?.shipment_allocation
        )
        .filter((allocation) => allocation?.plan_id === expected.plan_id)
        .map((allocation) => allocation.group_id)
      if (
        groups.length !== expected.groups.length ||
        new Set(groups).size !== groups.length ||
        expected.groups.some((group) => !groups.includes(group))
      )
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Select the combined delivery charge for all required warehouses."
        )
    }
  }
)
