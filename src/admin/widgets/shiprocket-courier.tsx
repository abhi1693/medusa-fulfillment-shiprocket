import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { DetailWidgetProps, HttpTypes } from "@medusajs/framework/types"
import { Container, Heading } from "@medusajs/ui"
import { FulfillmentCourier } from "../components/fulfillment-courier"
const CourierWidget = ({ data }: DetailWidgetProps<HttpTypes.AdminOrder>) => {
  const unfulfilled = data.items?.some(
    (item) =>
      item.requires_shipping &&
      Number(item.quantity) > Number(item.detail?.fulfilled_quantity || 0)
  )
  const methods = (data.shipping_methods || []).filter(
    (method) => (method.data as any)?.shiprocket_quote?.courier_company_id
  )
  if (!unfulfilled || !methods.length) return null
  return (
    <Container>
      <Heading level="h2">Shiprocket delivery selection</Heading>
      {methods.map((method) => (
        <FulfillmentCourier
          key={method.id}
          orderId={data.id}
          optionId={method.shipping_option_id!}
          quote={(method.data as any).shiprocket_quote}
        />
      ))}
    </Container>
  )
}
export const config = defineWidgetConfig({ zone: "order.details.side.before" })
export default CourierWidget
