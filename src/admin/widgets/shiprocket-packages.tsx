import { FulfillmentCourier } from "../components/fulfillment-courier"
import { useShiprocketOrder } from "../hooks/use-shiprocket-order"
import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { DetailWidgetProps, HttpTypes } from "@medusajs/framework/types"
import { Container, Heading, Text } from "@medusajs/ui"
import { useQuery } from "@tanstack/react-query"
import { sdk } from "../lib/client"

type Plan = {
  packages: {
    id: string
    title: string
    shipping_option_id: string
    location_id: string
    courier_company_id: number
    courier_name: string
    service: string
    carrier_amount: number
    affordable?: boolean
    remaining_budget?: number
    over_budget_amount?: number
    measurements: Record<string, number>
  }[]
  legacy_review_required: boolean
}
function Packages({ id, revision }: { id: string; revision: string }) {
  const plan = useQuery({
    queryKey: ["shiprocket-packages", id, revision],
    queryFn: () =>
      sdk.client.fetch<Plan>(`/admin/shiprocket-fulfillment/${id}/packages`),
    retry: false,
  })
  return (
    <Container className="divide-y divide-ui-border-base p-0">
      <div className="px-6 py-4">
        <Heading level="h2">Shipping</Heading>
      </div>
      {plan.isPending ? (
        <div className="px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">
            Loading shipping…
          </Text>
        </div>
      ) : plan.isError ? (
        <div className="px-6 py-4">
          <Text size="small" role="alert" className="text-ui-fg-error">
            {plan.error.message}
          </Text>
        </div>
      ) : (
        <>
          {plan.data.legacy_review_required && (
            <Text className="px-6 py-4" size="small">
              This order uses an earlier shipping quote. Review its existing
              shipment before fulfillment.
            </Text>
          )}
          {plan.data.packages.map((p, index) => (
            <div key={p.id} className="px-6 py-4">
              <FulfillmentCourier
                orderId={id}
                optionId={p.shipping_option_id}
                packageId={p.id}
                label={`Package ${index + 1}`}
                parcelSummary={`${plan.data.packages.length > 1 ? `Package ${index + 1} · ` : ""}${p.title} · ${Number(p.measurements.weight_grams) / 1000} kg · ${Math.ceil(Number(p.measurements.length_mm) / 10)} × ${Math.ceil(Number(p.measurements.width_mm) / 10)} × ${Math.ceil(Number(p.measurements.height_mm) / 10)} cm`}
                quote={{
                  courier_company_id: p.courier_company_id,
                  courier_name: p.courier_name,
                  service: p.service,
                  carrier_amount: p.carrier_amount,
                  affordable: p.affordable,
                  remaining_budget: p.remaining_budget,
                  over_budget_amount: p.over_budget_amount,
                  origin_location_id: p.location_id,
                }}
              />
            </div>
          ))}
          {!plan.data.packages.length && (
            <div className="px-6 py-4">
              <Text size="small" className="text-ui-fg-subtle">
                No packages awaiting fulfillment.
              </Text>
            </div>
          )}
        </>
      )}
    </Container>
  )
}
const PackageWidget = ({ data }: DetailWidgetProps<HttpTypes.AdminOrder>) => {
  const { applicable } = useShiprocketOrder(data)
  if (!applicable) return null
  if (
    !(data.shipping_methods || []).some(
      (m) => (m.data as any)?.shiprocket_quote?.parcel_plan
    )
  )
    return null
  // Native fulfillment changes can leave the order version unchanged.
  const revision = JSON.stringify([
    data.version,
    data.updated_at,
    (data.fulfillments || [])
      .map((fulfillment) => [fulfillment.id, fulfillment.canceled_at])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ])
  return <Packages id={data.id} revision={revision} />
}
export default PackageWidget
export const config = defineWidgetConfig({ zone: "order.details.after" })
