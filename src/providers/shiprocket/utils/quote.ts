export type ShippingMeasurements = {
  weight_grams: unknown
  length_mm: unknown
  width_mm: unknown
  height_mm: unknown
}
export function shiprocketItemMeasurements(
  items: readonly (Record<string, any> | null | undefined)[]
): Record<string, ShippingMeasurements> {
  return Object.fromEntries(
    items
      .filter(
        (item): item is Record<string, any> => typeof item?.id === "string"
      )
      .map((item) => {
        const variant = item.variant || {}
        const product = item.product || variant.product || {}
        return [
          item.id,
          {
            weight_grams: variant.weight ?? product.weight,
            length_mm: variant.length ?? product.length,
            width_mm: variant.width ?? product.width,
            height_mm: variant.height ?? product.height,
          },
        ]
      })
  )
}
type RecordValue = Record<string, any>
function positive(value: unknown, label: string) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0)
    throw new Error("Measured " + label + " is required for Shiprocket pricing")
  return number
}
/** API-boundary minimum only; native measurements remain unchanged. */
export function shiprocketDimensionCm(value: unknown, label: string): number {
  return Math.max(0.5, positive(value, label))
}
export function shiprocketParcelDimensions(
  lengthMm: unknown,
  widthMm: unknown,
  heightMm: unknown
) {
  return {
    length: shiprocketDimensionCm(
      positive(lengthMm, "packed length") / 10,
      "packed length"
    ),
    breadth: shiprocketDimensionCm(
      positive(widthMm, "packed width") / 10,
      "packed width"
    ),
    height: shiprocketDimensionCm(
      positive(heightMm, "packed height") / 10,
      "packed height"
    ),
  }
}
export function shiprocketDeclaredWeight(
  items: RecordValue[],
  measurements?: Record<string, ShippingMeasurements>
): number {
  if (!items.length)
    throw new Error(
      "At least one shippable item is required for Shiprocket pricing"
    )
  let grams = 0
  for (const item of items) {
    const quantity = Number(item.quantity)
    if (!Number.isSafeInteger(quantity) || quantity < 1)
      throw new Error("Valid item quantity is required for Shiprocket pricing")
    const variant = item.variant || {}
    const product = item.product || variant.product || {}
    const weight =
      measurements?.[item.id]?.weight_grams ?? variant.weight ?? product.weight
    grams += positive(weight, "item weight") * quantity
  }
  return positive(grams, "total item weight")
}
export function shiprocketQuote(context: RecordValue) {
  if (String(context.currency_code || "").toLowerCase() !== "inr")
    throw new Error("Shiprocket pricing requires INR")
  const origin = context.from_location?.address
  const destination = context.shipping_address
  if (
    String(origin?.country_code || "").toLowerCase() !== "in" ||
    String(destination?.country_code || "").toLowerCase() !== "in"
  ) {
    throw new Error(
      "Shiprocket pricing requires Indian origin and destination addresses"
    )
  }
  const pickup = String(origin?.postal_code || "")
  const delivery = String(destination?.postal_code || "")
  if (!/^[1-9][0-9]{5}$/.test(pickup) || !/^[1-9][0-9]{5}$/.test(delivery))
    throw new Error(
      "Valid warehouse and delivery postcodes are required for Shiprocket pricing"
    )
  const items = context.items || []
  const measured = context.shiprocket_parcel
  if (measured)
    return {
      pickup_postcode: pickup,
      delivery_postcode: delivery,
      weight: positive(measured.weight_grams, "packed weight") / 1000,
      ...shiprocketParcelDimensions(
        measured.length_mm,
        measured.width_mm,
        measured.height_mm
      ),
      cod: 0,
    }
  // Serviceability accepts declared shipment weight without dimensions. Sum
  // actual unit weights and quantities; product dimensions do not describe a
  // measured multi-item carton and must never be added into an invented box.
  const weight =
    shiprocketDeclaredWeight(items, context.shiprocket_item_measurements) / 1000
  let dimensions: { length?: number; breadth?: number; height?: number } = {}
  if (items.length === 1 && Number(items[0].quantity) === 1) {
    const item = items[0]
    const variant = item.variant || {}
    const product = item.product || variant.product || {}
    const parcel = context.shiprocket_item_measurements?.[item.id] || {
      length_mm: variant.length ?? product.length,
      width_mm: variant.width ?? product.width,
      height_mm: variant.height ?? product.height,
    }
    if (
      [parcel.length_mm, parcel.width_mm, parcel.height_mm].every(
        (value) => Number.isFinite(Number(value)) && Number(value) > 0
      )
    )
      dimensions = shiprocketParcelDimensions(
        parcel.length_mm,
        parcel.width_mm,
        parcel.height_mm
      )
  }
  return {
    pickup_postcode: pickup,
    delivery_postcode: delivery,
    weight,
    ...dimensions,
    cod: 0,
  }
}

export function shiprocketRate(couriers: any[], allowed?: number[]): number {
  const eligible = couriers
    .filter(
      (courier) =>
        !allowed?.length || allowed.includes(Number(courier.courier_company_id))
    )
    .map((courier) => Number(courier.rate))
    .filter((rate) => Number.isFinite(rate) && rate > 0)
  if (!eligible.length)
    throw new Error(
      "No available Shiprocket courier returned a valid prepaid rate"
    )
  // Shiprocket and Medusa v2 both use major INR units; preserve paise precision.
  return Math.min(...eligible)
}
