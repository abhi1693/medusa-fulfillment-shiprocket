/** Shiprocket's unzoned timestamps are IST; never substitute the requested pickup date. */
export function carrierDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined
  let text = value.trim().replace(" ", "T")
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += "T00:00:00"
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) text += "+05:30"
  const date = new Date(text)
  return Number.isFinite(date.getTime()) ? date : undefined
}
