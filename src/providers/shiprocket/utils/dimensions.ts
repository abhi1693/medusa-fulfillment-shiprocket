import type { ShippingMeasurements } from "./quote"
/** Native Medusa values remain grams/mm; unset variant fields inherit product values. */
export function getLineItemDimensions(
  variant: any,
  measurements?: ShippingMeasurements
) {
  const product = variant?.product
  const weightGrams = Number(
    measurements?.weight_grams ?? variant?.weight ?? product?.weight ?? 0
  )
  return {
    weightGrams,
    weightKg: weightGrams / 1000,
    length: Number(
      measurements?.length_mm ?? variant?.length ?? product?.length ?? 0
    ),
    width: Number(
      measurements?.width_mm ?? variant?.width ?? product?.width ?? 0
    ),
    height: Number(
      measurements?.height_mm ?? variant?.height ?? product?.height ?? 0
    ),
  }
}
