import { shiprocketConnection } from "../../../../../../shared/connection"
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
// @ts-ignore - Explicit .js extension required for NodeNext resolution, maps to .ts source
import ShiprocketClient from "../../../../../../providers/shiprocket/client/index.js"
import { carrierDate } from "../../../../../../shared/carrier-date"
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
export const POST = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const { awb } = req.params

  if (!isValidAwb(awb)) {
    return fail(
      res,
      400,
      "INVALID_AWB",
      "AWB parameter is required and must be valid"
    )
  }

  try {
    const logger = req.scope.resolve("logger")
    const lockId = (req.body as any)?.fulfillment_id
    return await req.scope.resolve<any>("locking").execute(
      `shiprocket:pickup:${String(lockId ?? awb)}`,
      async () => {
        const trackingService = req.scope.resolve<any>(
          SHIPROCKET_TRACKING_MODULE
        )
        const fulfillmentService = req.scope.resolve<any>("fulfillment")

        const connection = await shiprocketConnection(req.scope)

        const client = new ShiprocketClient({
          ...connection,
          logger,
        })

        try {
          const fulfillmentId = (req.body as any)?.fulfillment_id
          let fulfillment: any
          let pickup:
            | {
                scheduled: boolean
                failed?: boolean
                pickup_scheduled_date?: string
              }
            | undefined
          if (fulfillmentId !== undefined) {
            if (
              typeof fulfillmentId !== "string" ||
              !fulfillmentId ||
              fulfillmentId.length > 128
            )
              return fail(
                res,
                400,
                "MISSING_DATA",
                "A valid fulfillment_id is required"
              )
            fulfillment = await fulfillmentService.retrieveFulfillment(
              fulfillmentId,
              { relations: ["labels"] }
            )
            const boundAwb =
              fulfillment?.tracking_number || fulfillment?.data?.tracking_number
            if (
              !fulfillment?.provider_id?.includes("shiprocket") ||
              fulfillment.canceled_at ||
              boundAwb !== awb
            )
              return fail(
                res,
                400,
                "AWB_MISMATCH",
                "fulfillment_id does not belong to this active Shiprocket AWB"
              )
            try {
              pickup = await client.inspectPickup(fulfillment.data, awb)
              if (
                fulfillment.data.shiprocket_pickup_confirmed === true &&
                !pickup.scheduled &&
                !pickup.failed
              ) {
                pickup = {
                  ...pickup,
                  scheduled: true,
                  pickup_scheduled_date:
                    fulfillment.data.shiprocket_pickup_scheduled_date,
                }
              }
            } catch {
              logger.warn(
                "Shiprocket shipment state could not be verified; manifest generation skipped"
              )
            }
          }
          const existing = await trackingService.findByAwb(awb)

          // Documents must not depend on whether activity tracking is available yet.
          type TrackingResponse = Awaited<
            ReturnType<ShiprocketClient["getTrackingInfo"]>
          >
          let trackingResponse: TrackingResponse | undefined
          try {
            trackingResponse = await client.getTrackingInfo(awb)
          } catch (error) {
            if (!fulfillment || !pickup) throw error
            logger.warn(
              "Shiprocket activity tracking unavailable; using verified shipment state"
            )
          }
          if (!trackingResponse?.tracking_data && (!fulfillment || !pickup)) {
            return fail(
              res,
              404,
              "NOT_FOUND",
              "No tracking data found from Shiprocket"
            )
          }
          const trackingData: Partial<TrackingResponse["tracking_data"]> =
            trackingResponse?.tracking_data ?? {}

          // Ensure status gets saved as a string (fixing "1" vs "AWB Assigned" issue)
          const savedStatus = existing?.current_status
          const pickupStatus =
            pickup?.scheduled &&
            (!savedStatus ||
              ["Unknown", "AWB Assigned", "Pending"].includes(savedStatus))
              ? "Pickup Scheduled"
              : savedStatus
          let status: any = pickup?.failed
            ? "Pickup Error"
            : trackingData.current_status ||
              trackingData.shipment_track?.[0]?.current_status ||
              pickupStatus ||
              "Unknown"

          if (pickup?.scheduled && /^(pickup error|13)$/i.test(String(status)))
            status = "Pickup Scheduled"

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
          const scans = trackingData.shipment_track_activities?.length
            ? trackingData.shipment_track_activities
            : trackingData.scans?.length
              ? trackingData.scans
              : undefined

          // Upsert tracking data
          const tracking = await trackingService.upsertByAwb({
            awb: awb,
            courier_name:
              trackInfo?.courier_name || trackingData.courier_name || undefined,
            current_status: status,
            current_status_id: trackingData.current_status_id ?? undefined,
            shipment_status: shipmentStatus ?? undefined,
            shipment_status_id: trackingData.shipment_status_id ?? undefined,
            current_timestamp: trackingData.current_timestamp
              ? new Date(trackingData.current_timestamp)
              : new Date(),
            etd: trackingData.etd
              ? new Date(trackingData.etd)
              : trackInfo?.edd
                ? new Date(trackInfo.edd)
                : null,
            awb_assigned_date: trackingData.awb_assigned_date
              ? new Date(trackingData.awb_assigned_date)
              : undefined,
            pickup_scheduled_date:
              carrierDate(trackingData.pickup_scheduled_date) ??
              carrierDate(pickup?.pickup_scheduled_date),
            scans: scans,
            pod_status:
              trackingData.pod_status || trackInfo?.pod_status || null,
            pod: trackingData.pod || trackInfo?.pod || null,
            is_return: trackingData.is_return || false,
            origin: trackInfo?.origin || null,
            destination: trackInfo?.destination || null,
            weight: trackInfo?.weight || null,
            raw_payload: trackingResponse,
          })

          // Handle document generation if fulfillment_id is provided
          let documents: {
            label_url: string
            invoice_url: string
            manifest_url: string
          } | null = null
          if (fulfillment && pickup) {
            try {
              if (fulfillment?.data?.shipment_id) {
                logger.debug(
                  `Syncing documents for Shipment ID: ${fulfillment.data.shipment_id}, Order ID: ${fulfillment.data.sr_order_id || fulfillment.data.order_id}`
                )

                const docs = await client.createDocuments(
                  {
                    shipment_id: fulfillment.data.shipment_id,
                    order_id:
                      fulfillment.data.sr_order_id || fulfillment.data.order_id,
                  },
                  {
                    pickupConfirmed: pickup?.scheduled === true,
                    pickupFailed: pickup.failed === true,
                  }
                )

                logger.debug(
                  `Shiprocket document URLs returned: label=${!!docs.label}, invoice=${!!docs.invoice}, manifest=${!!docs.manifest}`
                )

                // Only overwrite URLs that actually came back; a partial
                // upstream failure must not erase previously good URLs.
                const nextData: Record<string, unknown> = {
                  ...fulfillment.data,
                }
                nextData.shiprocket_document_status = docs.status || {}
                if (pickup)
                  nextData.shiprocket_pickup_confirmed = pickup.scheduled
                nextData.shiprocket_pickup_error = pickup.failed === true
                if (pickup?.scheduled || pickup.failed)
                  nextData.shiprocket_pickup_pending = false
                if (pickup?.pickup_scheduled_date)
                  nextData.shiprocket_pickup_scheduled_date =
                    pickup.pickup_scheduled_date
                if (docs.label) nextData.label_url = docs.label
                if (docs.invoice) nextData.invoice_url = docs.invoice
                if (docs.manifest) nextData.manifest_url = docs.manifest
                documents = {
                  ...(docs.status ? { status: docs.status } : {}),
                  label_url: String(nextData.label_url || ""),
                  invoice_url: String(nextData.invoice_url || ""),
                  manifest_url: String(nextData.manifest_url || ""),
                }
                // Update fulfillment with new document URLs
                await fulfillmentService.updateFulfillment(fulfillmentId, {
                  data: nextData,
                  ...(docs.label && fulfillment.labels?.length
                    ? {
                        labels: fulfillment.labels.map((label: any) => ({
                          id: label.id,
                          tracking_number: label.tracking_number,
                          tracking_url: label.tracking_url,
                          label_url:
                            label.tracking_number === awb
                              ? docs.label
                              : label.label_url,
                        })),
                      }
                    : {}),
                })
                logger.debug("Fulfillment updated with new document URLs")
              } else {
                logger.warn(
                  "Fulfillment missing shipment_id, cannot generate documents"
                )
              }
            } catch (docError) {
              logger.error(
                `Failed to update documents: ${(docError as Error).message}`
              )
              // Continue execution, don't fail the whole sync
            }
          }

          return ok(
            res,
            {
              message: "Tracking data synced successfully",
              tracking: {
                id: tracking.id,
                awb: tracking.awb,
                current_status: tracking.current_status,
                courier_name: tracking.courier_name,
                etd: tracking.etd,
                updated_at: tracking.updated_at,
              },
              pickup,
              documents, // Return documents if found
            },
            200
          )
        } finally {
          // Always dispose client
          client.dispose()
        }
      },
      { timeout: 2 }
    )
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
