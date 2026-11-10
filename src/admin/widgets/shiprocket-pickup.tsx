import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { DetailWidgetProps, HttpTypes } from "@medusajs/framework/types"
import { Button, Container, Heading, Text, Select } from "@medusajs/ui"
import { useEffect, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { sdk } from "../lib/client"
type Pickup = {
  id: string
  nickname: string
  address: string
  address_2: string
  city: string
  state: string
  postcode: string
}
type Catalog = { pickups: Pickup[]; scope: string; mode: string }
const PickupWidget = ({
  data,
}: DetailWidgetProps<HttpTypes.AdminStockLocation>) => {
  const queryClient = useQueryClient()
  const linked = String(data.metadata?.shiprocket_pickup_id || "")
  const [selected, setSelected] = useState(linked)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [failed, setFailed] = useState(false)
  const catalog = useQuery({
    queryKey: ["shiprocket-pickups"],
    queryFn: () => sdk.client.fetch<Catalog>("/admin/shiprocket-pickups"),
    staleTime: 60000,
    retry: false,
  })
  useEffect(() => {
    setSelected(linked)
  }, [data.id, linked])
  const pickup = catalog.data?.pickups.find((row) => row.id === selected)
  const wrongScope =
    !!data.metadata?.shiprocket_pickup_scope &&
    data.metadata.shiprocket_pickup_scope !== catalog.data?.scope
  const save = async (unlink = false) => {
    if (!unlink && (!pickup || !catalog.data)) return
    setSaving(true)
    setMessage("")
    setFailed(false)
    try {
      const id = unlink ? null : selected
      const result = await sdk.admin.stockLocation.update(data.id, {
        metadata: {
          shiprocket_pickup_id: id,
          shiprocket_pickup_scope: unlink ? null : catalog.data!.scope,
        },
      })
      if (
        String(result.stock_location.metadata?.shiprocket_pickup_id || "") !==
        String(id || "")
      )
        throw Error("The pickup link was not saved")
      await queryClient.invalidateQueries({ queryKey: ["stock_locations"] })
      setSelected(id || "")
      setMessage("")
    } catch {
      setFailed(true)
      setMessage(
        "The pickup link could not be saved. Check access and try again."
      )
    } finally {
      setSaving(false)
    }
  }
  return (
    <Container className="p-0">
      <div className="flex flex-col gap-4 px-6 py-4">
        <Heading level="h2">Link Shiprocket pickup address</Heading>
        {catalog.isPending ? (
          <Text size="small">Loading pickup addresses…</Text>
        ) : catalog.isError ? (
          <div>
            <Text size="small" role="alert">
              {catalog.error instanceof Error
                ? catalog.error.message
                : "Pickup addresses could not be loaded."}
            </Text>
            <Button
              variant="secondary"
              size="small"
              onClick={() => catalog.refetch()}
              isLoading={catalog.isFetching}
              disabled={catalog.isFetching}
            >
              Try again
            </Button>
          </div>
        ) : (
          <>
            {wrongScope && (
              <Text size="small">Select a pickup for this account.</Text>
            )}
            {!catalog.data?.pickups.length ? (
              <Text size="small">
                No existing pickup addresses were found in this connection.
              </Text>
            ) : (
              <Select
                value={selected || undefined}
                onValueChange={(value) => {
                  setSelected(value)
                  setMessage("")
                }}
                disabled={saving}
              >
                <Select.Trigger aria-label="Existing Shiprocket pickup">
                  <Select.Value placeholder="Select an existing pickup" />
                </Select.Trigger>
                <Select.Content>
                  {catalog.data.pickups.map((row) => (
                    <Select.Item key={row.id} value={row.id}>
                      {row.nickname} · ID {row.id} · {row.city} {row.postcode}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="small"
                onClick={() => save()}
                disabled={
                  !pickup || saving || (selected === linked && !wrongScope)
                }
                isLoading={saving}
              >
                Link
              </Button>
              <Button
                size="small"
                variant="secondary"
                onClick={() => save(true)}
                disabled={saving || !linked}
              >
                Unlink
              </Button>
            </div>
          </>
        )}
        {message && (
          <Text size="small" role={failed ? "alert" : "status"}>
            {message}
          </Text>
        )}
      </div>
    </Container>
  )
}
export const config = defineWidgetConfig({ zone: "location.details.after" })
export default PickupWidget
