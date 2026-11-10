import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
// @ts-ignore - Explicit .js extension required for NodeNext resolution, maps to .ts source
import ShiprocketClient from "../../../../../../providers/shiprocket/client/index.js"
import { fail, isValidAwb, ok } from "../../../../../../shared/http"

const SHIPROCKET_TRACKING_MODULE = "shiprocketTrackingModuleService"

/**
 * Admin Tracking Sync API
 * 
 * URL: POST /admin/shiprocket/tracking/:awb/sync
 * 
 * Manually fetches latest tracking data from Shiprocket and updates the database.
 * Useful when webhooks haven't fired or for on-demand updates.
 */
export const POST = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
    const { awb } = req.params

    if (!isValidAwb(awb)) {
        return fail(res, 400, "INVALID_AWB", "AWB parameter is required and must be valid")
    }

    try {
        const logger = req.scope.resolve("logger")
        const trackingService = req.scope.resolve<any>(SHIPROCKET_TRACKING_MODULE)
        const fulfillmentService = req.scope.resolve<any>("fulfillment")

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

            // Fetch latest tracking from Shiprocket API
            const trackingResponse = await client.getTrackingInfo(awb)

            if (!trackingResponse?.tracking_data) {
                return fail(res, 404, "NOT_FOUND", "No tracking data found from Shiprocket")
            }

            const trackingData = trackingResponse.tracking_data

            // Ensure status gets saved as a string (fixing "1" vs "AWB Assigned" issue)
            let status: any = trackingData.current_status || trackingData.track_status || "Unknown"

            // Shiprocket Status Map
            const statusMap: Record<string | number, string> = {
                1: "AWB Assigned",
                6: "Shipped",
                7: "Delivered",
                8: "Cancelled",
                9: "RTO Initiated",
                13: "Pickup Error",
                17: "In Transit",
                18: "In Transit",
                19: "RTO In Transit",
                20: "RTO In Transit",
                21: "Reached Destination",
            }

            let shipmentStatus: any = trackingData.shipment_status || null

            // Handle edge case where Shiprocket returns numbers for status
            if (statusMap[status]) {
                status = statusMap[status]
            } else if (typeof status === "number") {
                status = String(status)
            }

            if (shipmentStatus && statusMap[shipmentStatus]) {
                shipmentStatus = statusMap[shipmentStatus]
            } else if (typeof shipmentStatus === "number") {
                shipmentStatus = String(shipmentStatus)
            }

            const trackInfo = trackingData.shipment_track?.[0]
            const scans = trackingData.shipment_track_activities || trackingData.scans || []

            // Upsert tracking data
            const tracking = await trackingService.upsertByAwb({
                awb: awb,
                courier_name: trackInfo?.courier_name || trackingData.courier_name || null,
                current_status: status,
                current_status_id: trackingData.current_status_id || 0,
                shipment_status: shipmentStatus,
                shipment_status_id: trackingData.shipment_status_id || 0,
                current_timestamp: trackingData.current_timestamp ? new Date(trackingData.current_timestamp) : new Date(),
                etd: trackingData.etd ? new Date(trackingData.etd) : (trackInfo?.edd ? new Date(trackInfo.edd) : null),
                awb_assigned_date: trackingData.awb_assigned_date ? new Date(trackingData.awb_assigned_date) : null,
                pickup_scheduled_date: trackingData.pickup_scheduled_date ? new Date(trackingData.pickup_scheduled_date) : null,
                scans: scans,
                pod_status: trackingData.pod_status || trackInfo?.pod_status || null,
                pod: trackingData.pod || trackInfo?.pod || null,
                is_return: trackingData.is_return || false,
                origin: trackInfo?.origin || null,
                destination: trackInfo?.destination || null,
                weight: trackInfo?.weight || null,
                raw_payload: trackingResponse,
            })

            // Handle document generation if fulfillment_id is provided
            let documents: { label_url: string; invoice_url: string; manifest_url: string } | null = null;
            const fulfillmentId = (req.body as any)?.fulfillment_id

            if (typeof fulfillmentId === "string" && fulfillmentId.length > 0 && fulfillmentId.length <= 128) {
                try {
                    const fulfillment = await fulfillmentService.retrieveFulfillment(fulfillmentId)

                    // Bind the URL :awb to the fulfillment's tracking number to prevent
                    // cross-contamination of document URLs across shipments.
                    const fulfillmentAwb = fulfillment?.tracking_number || fulfillment?.data?.tracking_number
                    if (fulfillmentAwb && fulfillmentAwb !== awb) {
                        logger.warn(`Sync AWB mismatch: url=${awb} fulfillment=${fulfillmentAwb}`)
                        return fail(res, 400, "AWB_MISMATCH", "fulfillment_id does not belong to this AWB")
                    }

                    if (fulfillment?.data?.shipment_id) {
                        logger.debug(`Syncing documents for Shipment ID: ${fulfillment.data.shipment_id}, Order ID: ${fulfillment.data.sr_order_id || fulfillment.data.order_id}`)

                        const docs = await client.createDocuments({
                            shipment_id: fulfillment.data.shipment_id,
                            order_id: fulfillment.data.sr_order_id || fulfillment.data.order_id
                        })

                        logger.debug(`Documents generated from Shiprocket`)

                        documents = {
                            label_url: docs.label,
                            invoice_url: docs.invoice,
                            manifest_url: docs.manifest
                        }

                        // Only overwrite URLs that actually came back; a partial
                        // upstream failure must not erase previously good URLs.
                        const nextData: Record<string, unknown> = { ...fulfillment.data }
                        if (docs.label) nextData.label_url = docs.label
                        if (docs.invoice) nextData.invoice_url = docs.invoice
                        if (docs.manifest) nextData.manifest_url = docs.manifest
                        // Update fulfillment with new document URLs
                        await fulfillmentService.updateFulfillment(fulfillmentId, {
                            data: nextData,
                        })
                        logger.debug("Fulfillment updated with new document URLs")
                    } else {
                        logger.warn("Fulfillment missing shipment_id, cannot generate documents")
                    }
                } catch (docError) {
                    logger.error(`Failed to update documents: ${(docError as Error).message}`)
                    // Continue execution, don't fail the whole sync
                }
            }

            return ok(res, {
                message: "Tracking data synced successfully",
                tracking: {
                    id: tracking.id,
                    awb: tracking.awb,
                    current_status: tracking.current_status,
                    courier_name: tracking.courier_name,
                    etd: tracking.etd,
                    updated_at: tracking.updated_at,
                },
                documents // Return documents if found
            }, 200)
        } finally {
            // Always dispose client
            client.dispose()
        }
    } catch (error: any) {
        const logger = req.scope.resolve("logger")
        // Log message only. Passing the raw error object risks dumping an axios
        // error whose `config.data` holds the Shiprocket login body (email/password)
        // and whose `config.headers` holds the bearer token.
        logger.error(
            `Admin tracking sync error: ${error instanceof Error ? error.message : "unknown error"}`
        )

        return fail(res, 500, "SYNC_FAILED", "Failed to sync tracking data")
    }
}
