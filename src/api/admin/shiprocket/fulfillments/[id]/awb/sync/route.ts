import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { runAwbAction } from "../route"

/** Reconcile a verified AWB by fulfillment identity; this action never assigns one. */
export const POST = (req: AuthenticatedMedusaRequest, res: MedusaResponse) =>
  runAwbAction(req, res, true)
