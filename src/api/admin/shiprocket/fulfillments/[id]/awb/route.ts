import { shiprocketConnection } from "../../../../../../shared/connection"
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import ShiprocketClient from "../../../../../../providers/shiprocket/client/index.js"
import { DeferredAwbError } from "../../../../../../shared/deferred-awb"
import { fail, ok } from "../../../../../../shared/http"
import { randomUUID } from "node:crypto"
export const runAwbAction = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
  readOnly = false,
  retry = false
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
        if (retry) {
          const check = fulfillment.data?.shiprocket_awb_check
          const token = (req.body as any)?.retry_token
          if (
            !req.auth_context?.actor_id ||
            !fulfillment.data?.shiprocket_awb_pending ||
            !check ||
            check.id !== token ||
            check.attempt_id !==
              (fulfillment.data?.shiprocket_awb_attempt_id ?? null) ||
            !Number.isFinite(Date.parse(check.checked_at)) ||
            Date.now() - Date.parse(check.checked_at) > 300000
          )
            return fail(
              res,
              409,
              "AWB_RECHECK_REQUIRED",
              "Check AWB status again before confirming a retry. The shipment changed or the previous check expired."
            )
        }
        const client = new ShiprocketClient({
          ...(await shiprocketConnection(req.scope)),
          auto_assign_awb: false,
          logger,
        })
        let requested = false
        try {
          const assigned = await client.assignDeferredAwb(
            fulfillment.data,
            id,
            {
              pending:
                readOnly ||
                (!retry && fulfillment.data?.shiprocket_awb_pending === true),
              verifyBeforeAssign: retry,
              beforeAssign: async () => {
                const current = await service.retrieveFulfillment(id)
                if (current.canceled_at || current.data?.awb)
                  throw new DeferredAwbError(
                    "Shipment changed before AWB assignment. Check its status again."
                  )
                if (
                  retry &&
                  (current.data?.shiprocket_awb_check?.id !==
                    (req.body as any).retry_token ||
                    current.data?.shiprocket_awb_attempt_id !==
                      fulfillment.data?.shiprocket_awb_attempt_id)
                )
                  throw new DeferredAwbError(
                    "This retry confirmation was already used. Check AWB status again."
                  )
                await service.updateFulfillment(id, {
                  data: {
                    ...current.data,
                    shiprocket_awb_pending: true,
                    shiprocket_awb_check: null,
                    shiprocket_awb_attempt_id: randomUUID(),
                    shiprocket_awb_attempted_at: new Date().toISOString(),
                    ...(retry
                      ? {
                          shiprocket_awb_retry: {
                            actor_id: req.auth_context.actor_id,
                            confirmed_at: new Date().toISOString(),
                            checked_at:
                              fulfillment.data.shiprocket_awb_check.checked_at,
                            previous_attempt_id:
                              fulfillment.data.shiprocket_awb_attempt_id ??
                              null,
                          },
                        }
                      : {}),
                  },
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
            shiprocket_awb_check: null,
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
          if (readOnly && error instanceof DeferredAwbError && error.pending) {
            const current = await service.retrieveFulfillment(id)
            if (current.canceled_at || current.data?.awb)
              return fail(
                res,
                409,
                "SHIPMENT_CHANGED",
                "Shipment changed during its status check. Refresh before continuing."
              )
            const check = {
              id: randomUUID(),
              checked_at: new Date().toISOString(),
              attempt_id: current.data?.shiprocket_awb_attempt_id ?? null,
            }
            if (current.data?.shiprocket_awb_pending === true)
              await service.updateFulfillment(id, {
                data: { ...current.data, shiprocket_awb_check: check },
              })
            return ok(
              res,
              {
                pending: current.data?.shiprocket_awb_pending === true,
                retry_token:
                  current.data?.shiprocket_awb_pending === true
                    ? check.id
                    : undefined,
                checked_at: check.checked_at,
                message:
                  current.data?.shiprocket_awb_pending === true
                    ? "Shiprocket still reports this shipment without an AWB. You can wait and check again, or confirm a retry for this same shipment."
                    : "No AWB is assigned to this shipment yet.",
              },
              202
            )
          }
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
              : "AWB assignment could not be completed. Check AWB status for this same shipment.",
            {
              pending:
                fulfillment.data?.shiprocket_awb_pending === true ||
                (error instanceof DeferredAwbError
                  ? error.uncertain
                  : requested),
            }
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

export const POST = (req: AuthenticatedMedusaRequest, res: MedusaResponse) =>
  runAwbAction(req, res)
