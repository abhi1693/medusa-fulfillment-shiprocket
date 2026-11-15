import { useShiprocketOrder } from "../hooks/use-shiprocket-order"
import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { DetailWidgetProps, HttpTypes } from "@medusajs/framework/types"
import { Container, Heading, Text, Button } from "@medusajs/ui"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { sdk } from "../lib/client"

type Plan = {
  revision: string
  packages: {
    id: string
    title: string
    courier_name: string
    service: string
    carrier_amount: number
    measurements: Record<string, number>
  }[]
  legacy_review_required: boolean
}
function Packages({ id, revision }: { id: string; revision: string }) {
  const client = useQueryClient()
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("")
  const plan = useQuery({
    queryKey: ["shiprocket-packages", id, revision],
    queryFn: () =>
      sdk.client.fetch<Plan>(`/admin/shiprocket-fulfillment/${id}/packages`),
    retry: false,
  })
  async function dispatch() {
    if (!plan.data || busy) return
    setBusy(true)
    setMessage("")
    try {
      const result = await sdk.client.fetch<{
        completed: number
        error?: string
      }>(`/admin/shiprocket-fulfillment/${id}/packages`, {
        method: "POST",
        body: { revision: plan.data.revision },
      })
      setMessage(
        result.error
          ? `${result.completed} packages completed. ${result.error}`
          : `${result.completed} packages dispatched.`
      )
    } catch (e: any) {
      setMessage(
        e.message ||
          "Packages could not be dispatched. Try again on this order."
      )
    } finally {
      setBusy(false)
      await client.invalidateQueries()
    }
  }
  return (
    <Container>
      <Heading level="h2">Shipping packages</Heading>
      {plan.isPending ? (
        <Text>Loading packages…</Text>
      ) : plan.isError ? (
        <Text role="alert">{plan.error.message}</Text>
      ) : (
        <>
          {plan.data.legacy_review_required && (
            <Text>
              This order uses an earlier shipping quote. Review its existing
              shipment before fulfillment.
            </Text>
          )}
          {plan.data.packages.map((p, index) => (
            <div key={p.id} className="border-b border-ui-border-base py-3">
              <Text weight="plus">
                Package {index + 1} · {p.title}
              </Text>
              <Text size="small">
                {p.courier_name} · {p.service} · Carrier quote ₹
                {Math.round(p.carrier_amount)}
              </Text>
              <Text size="small">
                {Number(p.measurements.weight_grams) / 1000} kg ·{" "}
                {Math.ceil(Number(p.measurements.length_mm) / 10)} ×{" "}
                {Math.ceil(Number(p.measurements.width_mm) / 10)} ×{" "}
                {Math.ceil(Number(p.measurements.height_mm) / 10)} cm
              </Text>
            </div>
          ))}
          <Text size="small">
            {plan.data.packages.length
              ? "Each package has its own tracking. The customer's combined shipping charge stays unchanged."
              : "No packages awaiting dispatch."}
          </Text>
          {plan.data.packages.length > 0 && (
            <Button
              type="button"
              isLoading={busy}
              disabled={busy}
              onClick={dispatch}
            >
              Dispatch packages
            </Button>
          )}
        </>
      )}
      {message && <Text role="status">{message}</Text>}
    </Container>
  )
}
export default function PackageWidget({
  data,
}: DetailWidgetProps<HttpTypes.AdminOrder>) {
  const { applicable } = useShiprocketOrder(data)
  if (!applicable) return null
  if (
    !(data.shipping_methods || []).some(
      (m) => (m.data as any)?.shiprocket_quote
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
export const config = defineWidgetConfig({ zone: "order.details.after" })
