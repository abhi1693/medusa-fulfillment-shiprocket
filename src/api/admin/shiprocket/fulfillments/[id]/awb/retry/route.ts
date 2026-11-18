import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { runAwbAction } from "../route"
import { fail } from "../../../../../../../shared/http"

export const POST = (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const body = req.body as any
  if (
    !body ||
    body.confirm !== true ||
    typeof body.retry_token !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(body.retry_token) ||
    Object.keys(body).some((key) => !["confirm", "retry_token"].includes(key))
  )
    return fail(
      res,
      400,
      "AWB_CONFIRMATION_REQUIRED",
      "Check this shipment's AWB status and explicitly confirm its retry."
    )
  return runAwbAction(req, res, false, true)
}
