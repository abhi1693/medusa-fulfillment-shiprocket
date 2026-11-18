import type { MedusaContainer } from "@medusajs/framework/types"
import {
  addToCartWorkflow,
  updateLineItemInCartWorkflow,
  refreshCartItemsWorkflow,
} from "@medusajs/medusa/core-flows"
import { StepResponse } from "@medusajs/framework/workflows-sdk"
import {
  invalidateShiprocketCartQuotes,
  restoreShiprocketCartQuotes,
} from "../../shared/cart-shipping"
async function invalidateItemChange(
  { input }: { input: { cart_id: string } },
  { container }: { container: MedusaContainer }
) {
  const ids = await invalidateShiprocketCartQuotes(container, input.cart_id)
  return new StepResponse(undefined, ids)
}
async function restore(
  ids: string[] | undefined,
  { container }: { container: MedusaContainer }
) {
  await restoreShiprocketCartQuotes(container, ids)
}
// Item edits invalidate the selected quote; no carrier or pricing service is
// called here. Native cart refresh sees no selected Shiprocket method to reprice.
addToCartWorkflow.hooks.validate(invalidateItemChange, restore)
updateLineItemInCartWorkflow.hooks.validate(invalidateItemChange, restore)
// Native deletion has no validate hook. Its public refresh hook runs before the
// cart is refetched for shipping refresh; fingerprints detect the removed item.
// Matching fingerprints keep a newly selected checkout method intact.
refreshCartItemsWorkflow.hooks.setPricingContext(
  async ({ cart_id }, { container }) => {
    const ids = await invalidateShiprocketCartQuotes(container, cart_id, true)
    return new StepResponse({}, ids)
  },
  restore
)
