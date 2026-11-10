import type {
  MedusaRequest,
  MedusaResponse,
  MedusaNextFunction,
} from "@medusajs/framework/http"
import { prepareFulfillmentPickup } from "../shared/fulfillment-pickup"
export async function fulfillmentPickupMiddleware(
  req: MedusaRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction
) {
  try {
    const input = (req.validatedBody ?? req.body ?? {}) as any
    const token = await prepareFulfillmentPickup(
      req.scope,
      req.params.id,
      input
    )
    const additional = { ...(input.additional_data ?? {}) }
    delete additional.shiprocket_pickup_preflight
    if (token) additional.shiprocket_pickup_preflight = token
    req.body = { ...(req.body as any), additional_data: additional }
    if (req.validatedBody)
      req.validatedBody = { ...input, additional_data: additional }
    next()
  } catch (error) {
    next(error)
  }
}
