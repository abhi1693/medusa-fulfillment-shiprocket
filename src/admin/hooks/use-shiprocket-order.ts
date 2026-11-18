import type { HttpTypes } from "@medusajs/framework/types"
import { useQuery } from "@tanstack/react-query"
import { sdk } from "../lib/client"
export function useShiprocketOrder(order: HttpTypes.AdminOrder) {
  const candidate =
    order.status !== "canceled" &&
    order.items?.some(
      (i) =>
        i.requires_shipping &&
        Number(i.quantity) > Number(i.detail?.fulfilled_quantity || 0)
    ) &&
    (order.shipping_methods || []).some(
      (m) => (m.data as any)?.shiprocket_quote?.courier_company_id
    )
  const query = useQuery({
    queryKey: ["shiprocket-order-applicability", order.id, order.version],
    queryFn: () =>
      sdk.client.fetch<{ enabled: boolean; shipping_option_ids: string[] }>(
        `/admin/shiprocket-fulfillment/${order.id}/applicability`
      ),
    enabled: !!candidate,
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
  })
  return {
    applicable: !!candidate && query.isSuccess && query.data.enabled,
    optionIds: query.data?.enabled ? query.data.shipping_option_ids : [],
  }
}
