import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { fail, isValidAwb, ok } from "../../../../../shared/http"

// Module identifier - must match what's registered in medusa-config.ts
const SHIPROCKET_TRACKING_MODULE = "shiprocketTrackingModuleService"

/**
 * Admin Tracking API
 * 
 * URL: GET /admin/shiprocket/tracking/:awb
 * 
 * Returns full tracking data including raw payload (admin only).
 */
export const GET = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
    const { awb } = req.params

    if (!isValidAwb(awb)) {
        return fail(res, 400, "INVALID_AWB", "AWB parameter is required and must be valid")
    }

    try {
        const trackingService = req.scope.resolve<any>(SHIPROCKET_TRACKING_MODULE)

        const tracking = await trackingService.findByAwb(awb)

        if (!tracking) {
            return fail(res, 404, "NOT_FOUND", "Tracking not found")
        }

        // Return full tracking data for admin
        return ok(res, {
            tracking: {
                id: tracking.id,
                awb: tracking.awb,
                order_id: tracking.order_id,
                sr_order_id: tracking.sr_order_id,
                medusa_fulfillment_id: tracking.medusa_fulfillment_id,
                courier_name: tracking.courier_name,
                current_status: tracking.current_status,
                current_status_id: tracking.current_status_id,
                shipment_status: tracking.shipment_status,
                shipment_status_id: tracking.shipment_status_id,
                current_timestamp: tracking.current_timestamp,
                etd: tracking.etd,
                awb_assigned_date: tracking.awb_assigned_date,
                pickup_scheduled_date: tracking.pickup_scheduled_date,
                is_return: tracking.is_return,
                pod_status: tracking.pod_status,
                pod: tracking.pod,
                channel_id: tracking.channel_id,
                scans: tracking.scans || [],
                raw_payload_redacted: !!tracking.raw_payload,
                created_at: tracking.created_at,
                updated_at: tracking.updated_at,
            },
        })
    } catch (error: any) {
        const logger = req.scope.resolve("logger")
        // Log message only — the raw error may carry axios config with credentials.
        logger.error(
            `Admin tracking API error: ${error instanceof Error ? error.message : "unknown error"}`
        )
        return fail(res, 500, "INTERNAL_ERROR", "Internal server error")
    }
}
