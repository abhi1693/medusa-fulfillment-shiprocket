import { useShiprocketOrder } from "../hooks/use-shiprocket-order"
import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { DetailWidgetProps, HttpTypes } from "@medusajs/framework/types"
import { Container, Heading } from "@medusajs/ui"
import { FulfillmentCourier } from "../components/fulfillment-courier"
// Merchant selection is a display projection; the paid checkout quote stays immutable.
const displayQuote = (quote: any, override: any, optionId: string) => {
  const display = {
    ...quote,
    carrier_amount: quote.amount ?? quote.carrier_amount,
  }
  if (
    !override ||
    typeof override !== "object" ||
    Array.isArray(override) ||
    typeof quote.origin_location_id !== "string" ||
    !quote.origin_location_id ||
    override.location_id !== quote.origin_location_id ||
    (override.shipping_option_id !== undefined &&
      override.shipping_option_id !== optionId) ||
    !Number.isSafeInteger(override.courier_company_id) ||
    override.courier_company_id <= 0 ||
    typeof override.courier_name !== "string" ||
    !override.courier_name.trim() ||
    !["air", "surface"].includes(override.service) ||
    typeof override.amount !== "number" ||
    !Number.isFinite(override.amount) ||
    override.amount < 0
  )
    return display
  return {
    ...display,
    courier_company_id: override.courier_company_id,
    courier_name: override.courier_name,
    service: override.service,
    carrier_amount: override.amount,
    affordable: override.affordable,
    remaining_budget: override.remaining_budget,
    over_budget_amount: override.over_budget_amount,
  }
}
const CourierWidget = ({ data }: DetailWidgetProps<HttpTypes.AdminOrder>) => {
  const { applicable, optionIds } = useShiprocketOrder(data)
  const unfulfilled = data.items?.some(
    (item) =>
      item.requires_shipping &&
      Number(item.quantity) > Number(item.detail?.fulfilled_quantity || 0)
  )
  const methods = (data.shipping_methods || []).filter(
    (method) =>
      optionIds.includes(method.shipping_option_id!) &&
      !(method.data as any)?.shiprocket_quote?.parcel_plan &&
      (method.data as any)?.shiprocket_quote?.courier_company_id
  )
  if (!applicable || !unfulfilled || !methods.length) return null
  return (
    <Container className="divide-y divide-ui-border-base p-0">
      <div className="px-6 py-4">
        <Heading level="h2">Shipping</Heading>
      </div>
      {methods.map((method) => (
        <div key={method.id} className="px-6 py-4">
          <FulfillmentCourier
            orderId={data.id}
            optionId={method.shipping_option_id!}
            quote={displayQuote(
              (method.data as any).shiprocket_quote,
              (data.metadata as any)?.shiprocket_fulfillment_couriers?.[
                method.shipping_option_id!
              ],
              method.shipping_option_id!
            )}
          />
        </div>
      ))}
    </Container>
  )
}
export const config = defineWidgetConfig({ zone: "order.details.side.before" })
export default CourierWidget
