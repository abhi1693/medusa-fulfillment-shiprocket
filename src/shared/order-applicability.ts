import { MedusaError } from "@medusajs/framework/utils"
/** Native provider activation is synchronized from the loaded provider configuration. */
export async function shiprocketOrderApplicability(
  container: any,
  orderId: string
) {
  const query = container.resolve("query")
  const { data: providers } = await query.graph({
    entity: "fulfillment_provider",
    filters: { is_enabled: true },
    fields: ["id", "is_enabled"],
  })
  const active = new Set(
    providers
      .filter(
        (p: any) =>
          p.is_enabled === true && String(p.id).startsWith("shiprocket_")
      )
      .map((p: any) => p.id)
  )
  if (!active.size)
    return { enabled: false, shipping_option_ids: [] as string[] }
  const {
    data: [order],
  } = await query.graph({
    entity: "order",
    filters: { id: orderId },
    fields: [
      "id",
      "status",
      "items.id",
      "items.requires_shipping",
      "items.quantity",
      "items.detail.fulfilled_quantity",
      "items.variant.product.shipping_profile.id",
      "shipping_methods.shipping_option_id",
      "shipping_methods.data",
    ],
  })
  if (!order)
    throw new MedusaError(MedusaError.Types.NOT_FOUND, "Order not found")
  const remaining = (order.items || []).filter(
    (i: any) =>
      i.requires_shipping &&
      Number(i.quantity) > Number(i.detail?.fulfilled_quantity || 0)
  )
  const ids = (order.shipping_methods || [])
    .filter((m: any) => m.data?.shiprocket_quote?.courier_company_id)
    .map((m: any) => m.shipping_option_id)
    .filter(Boolean)
  if (order.status === "canceled" || !remaining.length || !ids.length)
    return { enabled: true, shipping_option_ids: [] as string[] }
  const { data: options } = await query.graph({
    entity: "shipping_option",
    filters: { id: ids },
    fields: ["id", "provider_id", "shipping_profile_id"],
  })
  return {
    enabled: true,
    shipping_option_ids: options
      .filter(
        (o: any) =>
          active.has(o.provider_id) &&
          (!o.shipping_profile_id ||
            remaining.some(
              (i: any) =>
                i.variant?.product?.shipping_profile?.id ===
                o.shipping_profile_id
            ))
      )
      .map((o: any) => String(o.id)),
  }
}
