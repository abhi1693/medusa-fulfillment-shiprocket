import { z } from "@medusajs/framework/zod"
import { shipmentPolicy } from "./shipment-policy"
import { courierPolicy } from "../providers/shiprocket/utils/courier-policy"
import { shiprocketTimeout } from "../providers/shiprocket/client/config"
export const operationalSettings = z
  .object({
    enabled: z.boolean(),
    multiple_items: z.enum(["split_shipment", "single_shipment"]),
    single_shipment_dimensions: z.enum(["largest_item", "stacked"]),
    missing_measurements: z.enum(["reject", "use_defaults"]),
    default_item_weight_grams: z.number().finite().positive().max(1000000),
    default_item_length_mm: z.number().finite().gt(5).max(100000),
    default_item_width_mm: z.number().finite().gt(5).max(100000),
    default_item_height_mm: z.number().finite().gt(5).max(100000),
    courier_selection: z.enum(["lowest_price", "highest_rating"]),
    courier_fallback: z.enum(["none", "relax_preferences"]),
    preferred_real_time_tracking: z.boolean(),
    preferred_pod: z.enum(["any", "instant", "on_request"]),
    preferred_call_before_delivery: z.boolean(),
    require_real_time_tracking: z.boolean(),
    pod_requirement: z.enum(["any", "instant", "on_request"]),
    require_call_before_delivery: z.boolean(),
    timeout: z.number().int().min(1000).max(300000),
    rate_cache_ttl_ms: z.number().int().min(0).max(3600000),
    verify_documents: z.boolean(),
    auto_assign_awb: z.boolean(),
    rate_diagnostics: z.boolean(),
    webhook_payload_retention_days: z.number().int().min(1).max(365),
    rounding_rupees: z
      .number()
      .int()
      .positive()
      .max(Math.floor(Number.MAX_SAFE_INTEGER / 100)),
    automatic_recovery: z.boolean(),
  })
  .strict()
export type OperationalSettings = z.infer<typeof operationalSettings>
export const operationalSave = z
  .object({
    revision: z.number().int().nonnegative(),
    settings: operationalSettings,
    webhook_token: z.string().min(32).max(1024).optional(),
  })
  .strict()
// Used only to initialize the singleton during normal schema migrations.
export function defaultOperationalSettings(): OperationalSettings {
  const p = courierPolicy()
  return operationalSettings.parse({
    ...shipmentPolicy(),
    enabled: false,
    courier_selection: p.selection,
    courier_fallback: p.fallback,
    preferred_real_time_tracking: p.preferred_real_time_tracking,
    preferred_pod: p.preferred_pod,
    preferred_call_before_delivery: p.preferred_call_before_delivery,
    require_real_time_tracking: p.require_real_time_tracking,
    pod_requirement: p.pod,
    require_call_before_delivery: p.require_call_before_delivery,
    timeout: shiprocketTimeout(60000),
    rate_cache_ttl_ms: 300000,
    verify_documents: true,
    auto_assign_awb: false,
    rate_diagnostics: true,
    webhook_payload_retention_days: 30,
    rounding_rupees: 1,
    automatic_recovery: true,
  })
}
