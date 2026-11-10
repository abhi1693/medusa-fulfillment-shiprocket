import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { shiprocketOrderApplicability } from "../../../../../shared/order-applicability"
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  res.json(await shiprocketOrderApplicability(req.scope, req.params.id))
}
