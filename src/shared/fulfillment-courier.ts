import { MedusaError } from "@medusajs/framework/utils"

export type FulfillmentCourierBinding = {
  shipping_option_id: string
  location_id: string
  scope: string
  package_id?: string
}

/** Merchant instructions supplement the immutable customer quote for this shipment only. */
export function fulfillmentCourier<T extends Record<string, any>>(
  metadata: any,
  binding: FulfillmentCourierBinding,
  fallback: T
): T {
  const override = binding.package_id
    ? metadata?.shiprocket_package_couriers?.[binding.package_id]
    : metadata?.shiprocket_fulfillment_couriers?.[binding.shipping_option_id]
  if (override === undefined) return fallback
  if (
    !override ||
    typeof override !== "object" ||
    Array.isArray(override) ||
    override.scope !== binding.scope ||
    override.location_id !== binding.location_id ||
    (binding.package_id
      ? !/^[a-f0-9]{64}$/.test(binding.package_id) ||
        override.shipping_option_id !== binding.shipping_option_id
      : override.shipping_option_id !== undefined &&
        override.shipping_option_id !== binding.shipping_option_id) ||
    !["air", "surface"].includes(override.service) ||
    !Number.isSafeInteger(override.courier_company_id) ||
    override.courier_company_id <= 0 ||
    typeof override.courier_name !== "string" ||
    !override.courier_name.trim() ||
    typeof override.amount !== "number" ||
    !Number.isFinite(override.amount) ||
    override.amount < 0
  )
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "The merchant courier selection does not match this delivery. Select an available courier again."
    )
  return {
    ...fallback,
    courier_company_id: override.courier_company_id,
    courier_name: override.courier_name,
    amount: override.amount,
    service: override.service,
  }
}
