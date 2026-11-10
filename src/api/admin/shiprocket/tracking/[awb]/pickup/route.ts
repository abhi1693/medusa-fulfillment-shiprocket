import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
// @ts-ignore
import ShiprocketClient from "../../../../../../providers/shiprocket/client/index.js"
import { fail, isValidAwb, ok } from "../../../../../../shared/http"

/**
 * Admin Schedule Pickup API
 * 
 * URL: POST /admin/shiprocket/tracking/:awb/pickup
 * 
 * Manually schedules or reschedules a pickup for a shipment on Shiprocket.
 */
export const POST = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
    const { awb } = req.params

    if (!isValidAwb(awb)) {
        return fail(res, 400, "INVALID_AWB", "AWB parameter is required and must be valid")
    }

    try {
        const logger = req.scope.resolve("logger")
        const fulfillmentService = req.scope.resolve<any>("fulfillment")

        const fulfillmentId = (req.body as any)?.fulfillment_id
        if (typeof fulfillmentId !== "string" || !fulfillmentId || fulfillmentId.length > 128) {
            return fail(res, 400, "MISSING_DATA", "fulfillment_id is required in the body")
        }

        const fulfillment = await fulfillmentService.retrieveFulfillment(fulfillmentId)
        const fulfillmentAwb = fulfillment?.tracking_number || fulfillment?.data?.tracking_number
        if (fulfillmentAwb && fulfillmentAwb !== awb) {
            return fail(res, 400, "AWB_MISMATCH", "fulfillment_id does not belong to this AWB")
        }
        const shipmentId = fulfillment?.data?.shipment_id

        if (!Number.isFinite(Number(shipmentId))) {
            return fail(res, 400, "MISSING_DATA", "No valid shipment_id found on the specified fulfillment")
        }

        // Ensure credentials exist
        const email = process.env.SHIPROCKET_EMAIL
        const password = process.env.SHIPROCKET_PASSWORD

        if (!email || !password) {
            throw new Error("Shiprocket credentials (SHIPROCKET_EMAIL, SHIPROCKET_PASSWORD) missing in environment")
        }

        const client = new ShiprocketClient({
            email,
            password,
        })

        try {
            const success = await client.schedulePickup(shipmentId)

            if (success) {
                return ok(res, { message: "Pickup scheduled successfully", shipment_id: shipmentId }, 200)
            } else {
                return fail(res, 400, "SCHEDULE_FAILED", "Failed to schedule pickup with Shiprocket. Check logs for details.")
            }
        } finally {
            client.dispose()
        }
    } catch (error: any) {
        const logger = req.scope.resolve("logger")
        // Log message only — the raw error may carry axios config with credentials.
        logger.error(
            `Admin pickup schedule error: ${error instanceof Error ? error.message : "unknown error"}`
        )
        return fail(res, 500, "INTERNAL_ERROR", "Failed to schedule pickup")
    }
}
