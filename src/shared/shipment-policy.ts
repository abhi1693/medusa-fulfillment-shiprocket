export type ShipmentPolicy = {
  multiple_items: "split_shipment" | "single_shipment"
  single_shipment_dimensions: "largest_item" | "stacked"
  missing_measurements: "reject" | "use_defaults"
  default_item_weight_grams: number
  default_item_length_mm: number
  default_item_width_mm: number
  default_item_height_mm: number
}
export type ShipmentPolicyOptions = {
  multiple_items?: string
  single_shipment_dimensions?: string
  missing_measurements?: string
  default_item_weight_grams?: string | number
  default_item_length_mm?: string | number
  default_item_width_mm?: string | number
  default_item_height_mm?: string | number
}
export function shipmentPolicy(
  options: ShipmentPolicyOptions = {}
): ShipmentPolicy {
  const multiple_items = options.multiple_items ?? "split_shipment"
  const single_shipment_dimensions =
    options.single_shipment_dimensions ?? "largest_item"
  if (!["split_shipment", "single_shipment"].includes(multiple_items))
    throw Error(
      "SHIPROCKET_MULTIPLE_ITEMS must be split_shipment or single_shipment"
    )
  if (!["largest_item", "stacked"].includes(single_shipment_dimensions))
    throw Error(
      "SHIPROCKET_SINGLE_SHIPMENT_DIMENSIONS must be largest_item or stacked"
    )
  const missing_measurements = options.missing_measurements ?? "reject"
  if (!["reject", "use_defaults"].includes(missing_measurements))
    throw Error(
      "SHIPROCKET_MISSING_MEASUREMENTS must be reject or use_defaults"
    )
  function minimum(
    key:
      | "default_item_weight_grams"
      | "default_item_length_mm"
      | "default_item_width_mm"
      | "default_item_height_mm",
    fallback: number
  ) {
    const name = key
    const value = Number(options[key] ?? fallback)
    if (
      !Number.isFinite(value) ||
      value <= (key === "default_item_weight_grams" ? 0 : 5)
    )
      throw Error(
        name +
          (key === "default_item_weight_grams"
            ? " must be greater than zero"
            : " must be greater than 5 mm")
      )
    return value
  }
  return {
    multiple_items,
    single_shipment_dimensions,
    missing_measurements,
    default_item_weight_grams: minimum("default_item_weight_grams", 500),
    default_item_length_mm: minimum("default_item_length_mm", 6),
    default_item_width_mm: minimum("default_item_width_mm", 6),
    default_item_height_mm: minimum("default_item_height_mm", 6),
  } as ShipmentPolicy
}

export function fallbackMeasurements(
  measurements:
    | import("../providers/shiprocket/utils/quote").ShippingMeasurements
    | undefined,
  policy: ShipmentPolicy
) {
  if (policy.missing_measurements !== "use_defaults") return measurements
  return {
    weight_grams:
      measurements?.weight_grams ?? policy.default_item_weight_grams,
    length_mm: measurements?.length_mm ?? policy.default_item_length_mm,
    width_mm: measurements?.width_mm ?? policy.default_item_width_mm,
    height_mm: measurements?.height_mm ?? policy.default_item_height_mm,
  }
}
