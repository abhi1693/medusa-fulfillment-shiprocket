export type ParcelWeightSource =
  | "shipment_exact"
  | "original_two_decimal_projection"

function kilograms(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null
  const text = String(value).trim()
  if (!/^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text))
    return null
  const number = Number(text)
  return Number.isFinite(number) && number > 0 ? number : null
}

// Preserve the existing sub-milligram allowance for native float tails.
const sameWeight = (actual: number, expected: number) =>
  Math.abs(actual - expected) < 0.000001

// Decimal half-up avoids binary rounding errors at values such as 1.005 kg.
function twoDecimals(value: number): number {
  const [coefficient, exponent = "0"] = String(value).split("e")
  const [integer, fraction = ""] = coefficient.split(".")
  const digits = integer + fraction
  const places = integer.length + Number(exponent) + 2
  if (places < 0) return 0
  const padded = digits.padEnd(places + 1, "0")
  const hundredths =
    BigInt(padded.slice(0, places) || "0") +
    (Number(padded[places]) >= 5 ? 1n : 0n)
  return Number(`${hundredths}e-2`)
}

/** Original declared weight must independently corroborate any lossy readback.
 * A present contradictory/invalid original never disappears behind a matching
 * shipment field. Legacy responses may omit it only for an exact shipment.
 */
export function parcelWeightSource(
  shipmentWeight: unknown,
  originalWeight: unknown,
  expectedWeight: unknown
): ParcelWeightSource | null {
  const shipment = kilograms(shipmentWeight)
  const expected = kilograms(expectedWeight)
  const original = kilograms(originalWeight)
  if (shipment === null || expected === null) return null
  if (
    originalWeight !== undefined &&
    (original === null || !sameWeight(original, expected))
  )
    return null
  if (sameWeight(shipment, expected)) return "shipment_exact"
  if (original === null || !sameWeight(original, expected)) return null
  return sameWeight(shipment, twoDecimals(original))
    ? "original_two_decimal_projection"
    : null
}
