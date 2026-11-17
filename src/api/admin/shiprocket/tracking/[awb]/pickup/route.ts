import { shiprocketConnection } from "../../../../../../shared/connection"
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
// @ts-ignore
import ShiprocketClient from "../../../../../../providers/shiprocket/client/index.js"
import { fail, isValidAwb, ok } from "../../../../../../shared/http"

/**
 * Admin Schedule Pickup API
 *
 * URL: POST /admin/shiprocket/tracking/:awb/pickup
 *
 * Manually schedules a pickup for a shipment on Shiprocket.
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
    const fulfillmentService = req.scope.resolve<any>("fulfillment")

    const fulfillmentId = (req.body as any)?.fulfillment_id
    if (
      typeof fulfillmentId !== "string" ||
      !fulfillmentId ||
      fulfillmentId.length > 128
    ) {
      return fail(
        res,
        400,
        "MISSING_DATA",
        "fulfillment_id is required in the body"
      )
    }

    return await req.scope.resolve<any>("locking").execute(
      `shiprocket:pickup:${fulfillmentId}`,
      async () => {
        const fulfillment =
          await fulfillmentService.retrieveFulfillment(fulfillmentId)
        const fulfillmentAwb =
          fulfillment?.tracking_number || fulfillment?.data?.tracking_number
        if (
          !fulfillment?.provider_id?.includes("shiprocket") ||
          fulfillment.canceled_at ||
          fulfillmentAwb !== awb
        ) {
          return fail(
            res,
            400,
            "AWB_MISMATCH",
            "fulfillment_id does not belong to this AWB"
          )
        }
        const shipmentId = fulfillment?.data?.shipment_id

        if (
          !Number.isSafeInteger(Number(shipmentId)) ||
          Number(shipmentId) <= 0
        ) {
          return fail(
            res,
            400,
            "MISSING_DATA",
            "No valid shipment_id found on the specified fulfillment"
          )
        }

        const connection = await shiprocketConnection(req.scope)

        const client = new ShiprocketClient({
          ...connection,
          logger,
        })

        try {
          const existing = await client.inspectPickup(fulfillment.data, awb)
          if (!existing.scheduled && !existing.can_schedule)
            return fail(
              res,
              400,
              "PICKUP_STATE",
              "Shipment is not in a state that permits pickup scheduling"
            )
          if (
            !existing.scheduled &&
            !existing.failed &&
            fulfillment.data.shiprocket_pickup_pending
          )
            return fail(
              res,
              409,
              "PICKUP_UNCERTAIN",
              "An earlier pickup request is unresolved. Verify it in Shiprocket before another request."
            )
          const savedConfirmation =
            !existing.failed &&
            fulfillment.data.shiprocket_pickup_confirmed === true
          let pickup: {
            raw_response?: Record<string, unknown>
            scheduled: boolean
            uncertain?: boolean
            pickup_scheduled_date?: string
            message?: string
          }
          if (existing.scheduled || savedConfirmation)
            pickup = {
              ...existing,
              scheduled: true,
              pickup_scheduled_date:
                existing.pickup_scheduled_date ||
                fulfillment.data.shiprocket_pickup_scheduled_date,
            }
          else {
            // A crash or transport timeout must not make the next request replay a booking.
            await fulfillmentService.updateFulfillment(fulfillmentId, {
              data: {
                ...fulfillment.data,
                shiprocket_pickup_pending: true,
                ...(existing.failed
                  ? {
                      shiprocket_pickup_confirmed: false,
                      shiprocket_pickup_error: true,
                    }
                  : {}),
              },
            })
            pickup = await client.requestPickup(
              shipmentId,
              undefined,
              existing.failed === true
            )
          }

          if (pickup.scheduled) {
            // Preserve the acknowledgement even if tracking activities are not available yet.
            await fulfillmentService.updateFulfillment(fulfillmentId, {
              data: {
                ...fulfillment.data,
                shiprocket_pickup_confirmed: true,
                shiprocket_pickup_error: false,
                shiprocket_pickup_pending: false,
                ...(pickup.raw_response
                  ? { shiprocket_pickup_response: pickup.raw_response }
                  : {}),
                ...(pickup.pickup_scheduled_date
                  ? {
                      shiprocket_pickup_scheduled_date:
                        pickup.pickup_scheduled_date,
                    }
                  : {}),
              },
            })
            return ok(
              res,
              {
                message: "Pickup confirmed by Shiprocket",
                shipment_id: shipmentId,
                pickup,
              },
              200
            )
          } else {
            if (!pickup.uncertain)
              await fulfillmentService.updateFulfillment(fulfillmentId, {
                data: {
                  ...fulfillment.data,
                  shiprocket_pickup_pending: false,
                  ...(existing.failed
                    ? {
                        shiprocket_pickup_confirmed: false,
                        shiprocket_pickup_error: true,
                      }
                    : {}),
                },
              })
            return fail(
              res,
              pickup.uncertain ? 409 : 400,
              "SCHEDULE_FAILED",
              pickup.message ||
                "Pickup was not confirmed. Verify carrier state before retrying."
            )
          }
        } finally {
          client.dispose()
        }
      },
      { timeout: 2 }
    )
  } catch (error: any) {
    const logger = req.scope.resolve("logger")
    // Log message only — the raw error may carry axios config with credentials.
    logger.error(
      `Admin pickup schedule error: ${error instanceof Error ? error.message : "unknown error"}`
    )
    return fail(res, 500, "INTERNAL_ERROR", "Failed to schedule pickup")
  }
}
