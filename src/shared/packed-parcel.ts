export type PackedParcel = {
  weight_grams: number
  length_mm: number
  width_mm: number
  height_mm: number
  items: { id: string; quantity: number }[]
}
export function parcelItemsKey(
  items: { id: string; quantity: number }[]
): string {
  if (!Array.isArray(items) || !items.length)
    throw Error("Select the items in this parcel.")
  const rows = items
    .map((row) => {
      if (
        !row.id ||
        !Number.isSafeInteger(Number(row.quantity)) ||
        Number(row.quantity) <= 0
      )
        throw Error("Parcel item quantities must be positive whole numbers.")
      return { id: row.id, quantity: Number(row.quantity) }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw Error("Parcel items must not repeat.")
  return JSON.stringify(rows)
}
export function validatePackedParcel(value: any): PackedParcel {
  for (const key of ["weight_grams", "length_mm", "width_mm", "height_mm"]) {
    if (
      typeof value?.[key] !== "number" ||
      !Number.isFinite(value[key]) ||
      value[key] <= 0
    )
      throw Error("Enter the measured parcel weight and all three dimensions.")
  }
  parcelItemsKey(value.items)
  return value as PackedParcel
}
export function packedParcelForItems(
  metadata: any,
  optionId: string,
  items: { id: string; quantity: number }[]
): PackedParcel | undefined {
  const value = metadata?.shiprocket_parcels?.[optionId]
  if (!value) return undefined
  const parcel = validatePackedParcel(value)
  if (parcelItemsKey(parcel.items) !== parcelItemsKey(items))
    throw Error(
      "The saved packed parcel is for different items or quantities. Update Packed parcel on this order before fulfilling."
    )
  return parcel
}

export function parcelRevision(value: unknown): string {
  if (value == null) return "none"
  const parcel = validatePackedParcel(value)
  return JSON.stringify([
    parcel.weight_grams,
    parcel.length_mm,
    parcel.width_mm,
    parcel.height_mm,
    parcelItemsKey(parcel.items),
  ])
}
