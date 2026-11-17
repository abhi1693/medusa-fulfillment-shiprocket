import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import ShiprocketClient from "../../../../../../providers/shiprocket/client/index.js"
import { DeferredAwbError } from "../../../../../../shared/deferred-awb"
import { fail, ok } from "../../../../../../shared/http"
export const POST = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const { id } = req.params
  if (!id || id.length > 128)
    return fail(
      res,
      400,
      "INVALID_FULFILLMENT",
      "A valid fulfillment is required"
    )
  const logger = req.scope.resolve("logger")
  try {
    return await req.scope.resolve<any>("locking").execute(
      `shiprocket:awb:${id}`,
      async () => {
        const service = req.scope.resolve<any>("fulfillment")
        let fulfillment = await service.retrieveFulfillment(id, {
          relations: ["labels"],
        })
        if (
          !fulfillment?.provider_id?.includes("shiprocket") ||
          fulfillment.canceled_at
        )
          return fail(
            res,
            400,
            "INVALID_FULFILLMENT",
            "An active Shiprocket fulfillment is required"
          )
        if (
          (fulfillment.shipped_at || fulfillment.delivered_at) &&
          !fulfillment.data?.awb
        )
          return fail(
            res,
            409,
            "SHIPMENT_STATE",
            "This fulfillment was already marked shipped. Review it before assigning an AWB."
          )
        const client = new ShiprocketClient({
          email: process.env.SHIPROCKET_EMAIL,
          password: process.env.SHIPROCKET_PASSWORD,
          verify_documents: process.env.SHIPROCKET_VERIFY_DOCUMENTS !== "false",
          auto_assign_awb: false,
          logger,
        })
        let requested = false
        try {
          const assigned = await client.assignDeferredAwb(
            fulfillment.data,
            id,
            {
              pending: fulfillment.data?.shiprocket_awb_pending === true,
              beforeAssign: async () => {
                await service.updateFulfillment(id, {
                  data: { ...fulfillment.data, shiprocket_awb_pending: true },
                })
                requested = true
              },
            }
          )
          fulfillment = await service.retrieveFulfillment(id, {
            relations: ["labels"],
          })
          if (fulfillment.canceled_at)
            throw new DeferredAwbError(
              "Fulfillment was cancelled during assignment. Review the carrier shipment.",
              true
            )
          const labels = fulfillment.labels || []
          if (
            labels.some(
              (label: any) =>
                label.tracking_number && label.tracking_number !== assigned.awb
            )
          )
            throw new DeferredAwbError(
              "Native tracking does not match the assigned AWB. Review this shipment.",
              true
            )
          const data = {
            ...fulfillment.data,
            ...assigned,
            shiprocket_awb_pending: false,
          }
          await service.updateFulfillment(id, {
            data,
            labels: labels.length
              ? labels.map((label: any) => ({
                  id: label.id,
                  tracking_number: assigned.awb,
                  tracking_url: assigned.tracking_url,
                  label_url: label.label_url || "",
                }))
              : [
                  {
                    tracking_number: assigned.awb,
                    tracking_url: assigned.tracking_url,
                    label_url: "",
                  },
                ],
          })
          // Documents and pickup are independent explicit actions after this acknowledgement.
          return ok(res, {
            awb: assigned.awb,
            tracking_url: assigned.tracking_url,
          })
        } catch (error: any) {
          if (
            requested &&
            error instanceof DeferredAwbError &&
            !error.uncertain
          ) {
            const saved = await service.retrieveFulfillment(id)
            await service.updateFulfillment(id, {
              data: { ...saved.data, shiprocket_awb_pending: false },
            })
          }
          return fail(
            res,
            error instanceof DeferredAwbError && error.uncertain ? 409 : 400,
            "AWB_ASSIGNMENT_FAILED",
            error instanceof DeferredAwbError
              ? error.message
              : "AWB assignment could not be completed. Retry this same shipment to verify its state."
          )
        } finally {
          client.dispose()
        }
      },
      { timeout: 2 }
    )
  } catch {
    logger.warn(
      "Shiprocket AWB action could not acquire its operation or load the fulfillment"
    )
    return fail(
      res,
      409,
      "SHIPMENT_BUSY",
      "This shipment is busy or unavailable. Refresh it before retrying."
    )
  }
}
