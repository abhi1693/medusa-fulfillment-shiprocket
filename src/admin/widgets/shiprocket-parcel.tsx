import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { DetailWidgetProps, HttpTypes } from "@medusajs/framework/types"
import {
  Container,
  Heading,
  Text,
  Button,
  Input,
  Label,
  Select,
} from "@medusajs/ui"
import { useState, useEffect, useMemo } from "react"
import { useQueryClient, useQuery } from "@tanstack/react-query"
import { sdk } from "../lib/client"
import {
  validatePackedParcel,
  parcelRevision,
  selectedItemWeight,
  type PackedParcel,
} from "../../shared/packed-parcel"
const fields = [
  ["weight_grams", "Weight (g)"],
  ["length_mm", "Length (mm)"],
  ["width_mm", "Width (mm)"],
  ["height_mm", "Height (mm)"],
] as const
const ParcelWidget = ({ data }: DetailWidgetProps<HttpTypes.AdminOrder>) => {
  const methods = (data.shipping_methods || []).filter(
    (method) => (method.data as any)?.shiprocket_quote
  )
  const [option, setOption] = useState(methods[0]?.shipping_option_id || "")
  const [values, setValues] = useState<Record<string, string>>({})
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false)
  const client = useQueryClient()
  const [weightEdited, setWeightEdited] = useState(false)
  const measurements = useQuery({
    queryKey: ["shiprocket-parcel-measurements", data.id, data.version],
    queryFn: () =>
      sdk.admin.order.retrieve(data.id, {
        fields: "id,items.id,items.variant.weight,items.variant.product.weight",
      }),
    staleTime: 60000,
    retry: false,
  })
  const calculatedWeight = useMemo(
    () =>
      selectedItemWeight(
        measurements.data?.order.items || data.items || [],
        quantities
      ),
    [measurements.data, quantities, data.items]
  )
  useEffect(() => {
    if (!weightEdited)
      setValues((previous) => ({
        ...previous,
        weight_grams:
          calculatedWeight.weight_grams === undefined
            ? ""
            : String(calculatedWeight.weight_grams),
      }))
  }, [calculatedWeight.weight_grams, weightEdited])
  const remaining = (item: any) =>
    Math.max(
      0,
      Number(item.quantity) - Number(item.detail?.fulfilled_quantity || 0)
    )
  useEffect(() => {
    const parcel = (data.metadata?.shiprocket_parcels as any)?.[option]
    setWeightEdited(!!parcel?.weight_grams)
    setValues(
      Object.fromEntries(
        fields.map(([key]) => [key, parcel?.[key] ? String(parcel[key]) : ""])
      )
    )
    setQuantities(
      Object.fromEntries(
        (data.items || [])
          .filter((item) => item.requires_shipping && remaining(item) > 0)
          .map((item) => [
            item.id,
            String(
              parcel?.items?.find((row: any) => row.id === item.id)?.quantity ??
                remaining(item)
            ),
          ])
      )
    )
    setSaved(false)
    setError("")
  }, [data.id, option, data.metadata])
  if (!methods.length) return null
  const save = async () => {
    setError("")
    setSaved(false)
    try {
      const items = Object.entries(quantities)
        .filter(([, q]) => Number(q) > 0)
        .map(([id, q]) => ({ id, quantity: Number(q) }))
      const parcel = validatePackedParcel({
        ...Object.fromEntries(
          fields.map(([key]) => [key, Number(values[key])])
        ),
        items,
      })
      for (const row of parcel.items) {
        const item = data.items?.find((i) => i.id === row.id)
        if (!item || row.quantity > remaining(item))
          throw Error("Parcel quantities exceed the unfulfilled items.")
      }
      setSaving(true)
      const latest = await sdk.admin.order.retrieve(data.id)
      // Dashboard's explicit detail projection omits updated_at. Compare the
      // native order version and the specific parcel, not an absent timestamp.
      if (
        (data.version !== undefined && latest.order.version !== data.version) ||
        parcelRevision(
          (latest.order.metadata?.shiprocket_parcels as any)?.[option]
        ) !==
          parcelRevision((data.metadata?.shiprocket_parcels as any)?.[option])
      )
        throw Error("This order changed. Reload it before saving the parcel.")
      for (const row of parcel.items) {
        const item = latest.order.items?.find((i) => i.id === row.id)
        if (!item || row.quantity > remaining(item))
          throw Error(
            "The unfulfilled items changed. Reload the order before saving the parcel."
          )
      }
      const previous = latest.order.metadata?.shiprocket_parcels
      const result = await sdk.admin.order.update(data.id, {
        metadata: {
          shiprocket_parcels: {
            ...(previous && typeof previous === "object" ? previous : {}),
            [option]: parcel,
          },
        },
      })
      if (!(result.order.metadata?.shiprocket_parcels as any)?.[option])
        throw Error("The parcel was not saved.")
      await client.invalidateQueries({ queryKey: ["orders"] })
      setSaved(true)
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "The parcel could not be saved. Try again."
      )
    } finally {
      setSaving(false)
    }
  }
  return (
    <Container>
      <div className="flex flex-col gap-4">
        <Heading level="h2">Packed parcel</Heading>
        <Text size="small">
          Enter the measured outer package for the items you will fulfill.
        </Text>
        {methods.length > 1 && (
          <Select value={option} onValueChange={setOption}>
            <Select.Trigger aria-label="Parcel delivery method">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {methods.map((method) => (
                <Select.Item key={method.id} value={method.shipping_option_id!}>
                  {method.name}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {fields.map(([key, label]) => (
            <div key={key} className="flex flex-col gap-2">
              <Label htmlFor={`parcel-${data.id}-${key}`}>{label}</Label>
              <Input
                id={`parcel-${data.id}-${key}`}
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                value={values[key] || ""}
                onChange={(e) => {
                  if (key === "weight_grams") setWeightEdited(true)
                  setValues({ ...values, [key]: e.target.value })
                  setSaved(false)
                }}
                disabled={saving}
              />
            </div>
          ))}
        </div>
        <Text size="small">
          {measurements.isFetching
            ? "Loading item weights…"
            : calculatedWeight.missing_ids.length
              ? "Some item weights are missing. Enter the measured packed weight."
              : "Weight starts with the selected items. Adjust it for packaging."}
        </Text>
        {(data.items || [])
          .filter((item) => item.requires_shipping && remaining(item) > 0)
          .map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between gap-4"
            >
              <Label htmlFor={`parcel-quantity-${item.id}`}>
                {item.title} · {item.variant_title}
              </Label>
              <Input
                className="w-24"
                id={`parcel-quantity-${item.id}`}
                aria-label={`Packed quantity: ${item.title}`}
                type="number"
                min="0"
                max={remaining(item)}
                step="1"
                value={quantities[item.id] || "0"}
                onChange={(e) => {
                  setWeightEdited(false)
                  setQuantities({ ...quantities, [item.id]: e.target.value })
                  setSaved(false)
                }}
                disabled={saving}
              />
            </div>
          ))}
        {error && (
          <Text size="small" role="alert">
            {error}
          </Text>
        )}
        {saved && (
          <Text size="small" role="status">
            Parcel saved.
          </Text>
        )}
        <div>
          <Button
            size="small"
            onClick={save}
            disabled={saving || !option}
            isLoading={saving}
          >
            Save parcel
          </Button>
        </div>
      </div>
    </Container>
  )
}
export const config = defineWidgetConfig({ zone: "order.details.after" })
export default ParcelWidget
