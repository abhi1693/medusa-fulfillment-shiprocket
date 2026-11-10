import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { fail, isValidAwb, ok } from "../../../../../shared/http"

// Module identifier - must match what's registered in medusa-config.ts
const SHIPROCKET_TRACKING_MODULE = "shiprocketTrackingModuleService"

/**
 * Public Tracking API
 * 
 * URL: GET /store/shiprocket/tracking/:awb
 * 
 * Returns tracking status and scan history for a shipment.
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

        // Security: fail closed — every linked record requires ownership proof.
        // Guest orders (customer_id == null), unlinked records, and deleted orders
        // must NOT fall through to public access.
        if (!tracking.medusa_order_id) {
            return fail(res, 404, "NOT_FOUND", "Tracking not found")
        }
        try {
            // Attempt to verify ownership
            const orderModule = req.scope.resolve("order")
            const order = await orderModule.retrieveOrder(tracking.medusa_order_id, {
                select: ["customer_id"]
            })

            // Get current user from auth context
            const actorId = req.auth_context?.actor_id

            if (!actorId) {
                return fail(res, 403, "ACCESS_DENIED", "Authentication is required to access this tracking record")
            }

            // Guest orders have no customer_id: only allow the owning session.
            // Without a customer binding we cannot prove ownership -> deny.
            if (!order.customer_id || order.customer_id !== actorId) {
                return fail(res, 403, "ACCESS_DENIED", "Access denied. You do not own this order.")
            }
        } catch (e) {
            // Ownership verification failed - deny access for security (fail closed,
            // including "order not found": a deleted order must not become public).
            const logger = req.scope.resolve("logger")
            logger.warn(`Tracking ownership check failed for AWB ${awb}: ${(e as Error).message}`)

            return fail(res, 403, "ACCESS_DENIED", "Access denied. Unable to verify order ownership.")
        }

        // Return cleaned tracking data (cap scan history for response size)
        const scans = Array.isArray(tracking.scans) ? tracking.scans.slice(-200) : []
        return ok(res, {
            tracking: {
                awb: tracking.awb,
                courier_name: tracking.courier_name,
                current_status: tracking.current_status,
                current_status_id: tracking.current_status_id,
                shipment_status: tracking.shipment_status,
                shipment_status_id: tracking.shipment_status_id,
                current_timestamp: tracking.current_timestamp,
                etd: tracking.etd,
                is_return: tracking.is_return,
                pod_status: tracking.pod_status,
                scans,
                updated_at: tracking.updated_at,
            },
        }, 200)
    } catch (error: any) {
        const logger = req.scope.resolve("logger")
        // Log message only — the raw error may carry axios config with credentials.
        logger.error(
            `Tracking API error: ${error instanceof Error ? error.message : "unknown error"}`
        )
        return fail(res, 500, "INTERNAL_ERROR", "Internal server error")
    }
}
