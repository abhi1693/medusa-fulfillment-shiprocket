import { signedCourierClaim } from "./quote-integrity"
import { createHash } from "node:crypto"
import type {
  MedusaContainer,
  ICartModuleService,
  IFulfillmentModuleService,
} from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
  MedusaError,
} from "@medusajs/framework/utils"
type CartContext = Record<string, any>
export const SHIPROCKET_CART_FINGERPRINT = "shiprocket_cart_fingerprint"
export function shiprocketCartFingerprint(
  context: CartContext
): string | undefined {
  if (!context?.id || !Array.isArray(context.items)) return undefined
  const items = context.items
    .filter(Boolean)
    .map((item: any) => [
      String(item.id || ""),
      String(item.variant_id || ""),
      String(item.product_id || ""),
      Number(item.quantity),
    ])
    .sort((a: any[], b: any[]) => String(a[0]).localeCompare(String(b[0])))
  if (
    items.some(
      (item: any[]) =>
        !item[0] || !Number.isSafeInteger(item[3]) || Number(item[3]) < 1
    )
  )
    return undefined
  return createHash("sha256")
    .update(
      JSON.stringify([
        String(context.id),
        String(context.currency_code || "").toLowerCase(),
        String(context.shipping_address?.country_code || "").toLowerCase(),
        String(context.shipping_address?.postal_code || "").trim(),
        items,
      ])
    )
    .digest("hex")
}
export function shiprocketPaymentPriceLocked(
  cart: Record<string, any>
): boolean {
  const total = Number(cart.total)
  return (
    Number.isFinite(total) &&
    (cart.payment_collection?.payment_sessions || []).some(
      (session: any) =>
        ["pending", "authorized", "captured"].includes(session.status) &&
        Number(session.amount) === total &&
        session.currency_code === cart.currency_code
    )
  )
}
export async function invalidateShiprocketCartQuotes(
  container: MedusaContainer,
  cartId: string,
  staleOnly = false,
  inspectOnly = false
): Promise<string[]> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const {
    data: [cart],
  } = await query.graph({
    entity: "cart",
    filters: { id: cartId },
    fields: [
      "id",
      "currency_code",
      "total",
      "payment_collection.payment_sessions.status",
      "payment_collection.payment_sessions.amount",
      "payment_collection.payment_sessions.currency_code",
      "shipping_address.country_code",
      "shipping_address.postal_code",
      "items.id",
      "items.variant_id",
      "items.product_id",
      "items.quantity",
      "shipping_methods.id",
      "shipping_methods.data",
      "shipping_methods.shipping_option_id",
      "shipping_methods.shipping_option.data",
      "shipping_methods.shipping_option.service_zone.fulfillment_set_id",
      "shipping_methods.shipping_option.provider_id",
      "shipping_methods.shipping_option.price_type",
    ],
  })
  if (!cart) return []
  const fingerprint = shiprocketCartFingerprint(cart)
  const methods = (cart.shipping_methods || []).filter(
    (method: any) =>
      method.shipping_option?.provider_id?.endsWith("_shiprocket") &&
      method.shipping_option.price_type === "calculated"
  )
  const ids: string[] = []
  const configurations = new Map<string, any>()
  for (const method of methods as any[]) {
    if (
      !staleOnly ||
      !fingerprint ||
      method.data?.[SHIPROCKET_CART_FINGERPRINT] !== fingerprint
    ) {
      ids.push(method.id)
      continue
    }
    if (shiprocketPaymentPriceLocked(cart)) continue
    const claim = signedCourierClaim(method.data?.shiprocket_quote)
    if (
      !claim ||
      claim.cart !== fingerprint ||
      claim.option !== method.shipping_option_id
    ) {
      ids.push(method.id)
      continue
    }
    const provider = method.shipping_option.provider_id
    if (!configurations.has(provider)) {
      const supported = await container
        .resolve<IFulfillmentModuleService>(Modules.FULFILLMENT)
        .retrieveFulfillmentOptions(provider)
      configurations.set(
        provider,
        supported.find((option: any) => option.shiprocket_policy) || {}
      )
    }
    const configuration = configurations.get(provider)
    if (
      (configuration.shiprocket_policy &&
        JSON.stringify(claim.policy) !==
          JSON.stringify(configuration.shiprocket_policy)) ||
      (configuration.shiprocket_account_scope &&
        claim.account !== configuration.shiprocket_account_scope)
    ) {
      ids.push(method.id)
      continue
    }
    const set = method.shipping_option.service_zone?.fulfillment_set_id
    if (set) {
      const { data: links } = await query.graph({
        entity: "location_fulfillment_set",
        filters: { fulfillment_set_id: set },
        fields: ["stock_location_id"],
      })
      const { data: locations } = links.length
        ? await query.graph({
            entity: "stock_location",
            filters: { id: links.map((link: any) => link.stock_location_id) },
            fields: ["id", "address.postal_code"],
          })
        : { data: [] }
      if (
        !locations.some(
          (location: any) =>
            location.id === claim.origin &&
            String(location.address?.postal_code) ===
              claim.params?.pickup_postcode
        )
      )
        ids.push(method.id)
    }
  }
  if (ids.length && !inspectOnly)
    await container
      .resolve<ICartModuleService>(Modules.CART)
      .softDeleteShippingMethods(ids)
  return ids
}
export async function restoreShiprocketCartQuotes(
  container: MedusaContainer,
  ids?: string[]
) {
  if (ids?.length)
    await container
      .resolve<ICartModuleService>(Modules.CART)
      .restoreShippingMethods(ids)
}

export async function assertFreshShiprocketCartQuotes(
  container: MedusaContainer,
  cartId: string
) {
  const ids = await invalidateShiprocketCartQuotes(
    container,
    cartId,
    true,
    true
  )
  if (ids.length)
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Delivery quote expired or changed. Choose delivery again before completing checkout."
    )
}
