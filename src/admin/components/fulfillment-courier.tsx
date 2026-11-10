import { Button, Text, Select } from "@medusajs/ui"
import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { sdk } from "../lib/client"
type Choice = {
  courier_company_id: number
  courier_name: string
  amount: number
  affordable: boolean
  estimated_delivery_days: string | null
}
type Catalog = {
  shipping_option_id: string
  service: string
  pickup_postcode: string
  delivery_postcode: string
  remaining_budget: number
  revision: string
  selected_courier_id: number
  couriers: Choice[]
}
export const FulfillmentCourier = ({
  orderId,
  optionId,
  quote,
}: {
  orderId: string
  optionId: string
  quote: any
}) => {
  const [selected, setSelected] = useState("")
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState("")
  const cache = useQueryClient()
  const catalog = useQuery({
    queryKey: ["shiprocket-fulfillment-couriers", orderId, optionId],
    queryFn: () =>
      sdk.client.fetch<Catalog>(
        `/admin/shiprocket-fulfillment/${orderId}/couriers`,
        { query: { shipping_option_id: optionId } }
      ),
    enabled: false,
    retry: false,
  })
  const refresh = async () => {
    setError("")
    setSaved("")
    setSelected("")
    await catalog.refetch()
  }
  const save = async () => {
    if (!catalog.data || !selected) return
    setSaving(true)
    setError("")
    setSaved("")
    try {
      const result = await sdk.client.fetch<{ courier_name: string }>(
        `/admin/shiprocket-fulfillment/${orderId}/couriers`,
        {
          method: "POST",
          body: {
            shipping_option_id: optionId,
            courier_company_id: Number(selected),
            revision: catalog.data.revision,
          },
        }
      )
      setSaved(result.courier_name)
      await cache.invalidateQueries({ queryKey: ["orders"] })
      await catalog.refetch()
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "The courier could not be selected. Try again."
      )
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="mt-3 flex flex-col gap-3">
      <Text>
        {quote.origin_location_name || "Selected warehouse"} ·{" "}
        {quote.service === "air" ? "Express (air)" : "Standard (surface)"}
      </Text>
      <Text size="small" className="text-ui-fg-subtle">
        Customer choice:{" "}
        {quote.courier_name || `Courier ${quote.courier_company_id}`}
      </Text>
      <Button
        size="small"
        variant="secondary"
        onClick={refresh}
        isLoading={catalog.isFetching}
        disabled={catalog.isFetching || saving}
      >
        Check available couriers
      </Button>
      {catalog.isError && (
        <Text size="small" role="alert">
          {catalog.error instanceof Error
            ? catalog.error.message
            : "Couriers could not be loaded. Try again."}
        </Text>
      )}
      {catalog.data && !catalog.isFetching && (
        <>
          <Text size="small">
            {catalog.data.pickup_postcode} → {catalog.data.delivery_postcode} ·
            Budget ₹{catalog.data.remaining_budget.toFixed(2)}
          </Text>
          {catalog.data.couriers.length ? (
            <Select
              value={selected || String(catalog.data.selected_courier_id)}
              onValueChange={(value) => {
                setSelected(value)
                setSaved("")
                setError("")
              }}
              disabled={saving}
            >
              <Select.Trigger aria-label={`Fulfillment courier ${optionId}`}>
                <Select.Value placeholder="Select courier" />
              </Select.Trigger>
              <Select.Content>
                {catalog.data.couriers.map((row) => (
                  <Select.Item
                    key={row.courier_company_id}
                    value={String(row.courier_company_id)}
                    disabled={!row.affordable}
                  >
                    {row.courier_name} · ID {row.courier_company_id} · ₹
                    {row.amount.toFixed(2)}
                    {row.estimated_delivery_days
                      ? ` · ${row.estimated_delivery_days} days`
                      : ""}
                    {!row.affordable ? " · Over budget" : ""}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
          ) : (
            <Text size="small">
              No eligible {catalog.data.service} couriers are available for this
              parcel.
            </Text>
          )}
          <Button
            size="small"
            onClick={save}
            isLoading={saving}
            disabled={
              saving ||
              !selected ||
              !catalog.data.couriers.some(
                (row) =>
                  row.courier_company_id === Number(selected) && row.affordable
              )
            }
          >
            Use courier
          </Button>
        </>
      )}
      {saved && (
        <Text size="small" role="status">
          {saved} selected.
        </Text>
      )}
      {error && (
        <Text size="small" role="alert">
          {error}
        </Text>
      )}
    </div>
  )
}
