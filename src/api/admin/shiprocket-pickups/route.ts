import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { readPickupCatalog } from "../../../shared/pickup-catalog"
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "private, no-store")
  try {
    res.json(await readPickupCatalog(req.scope))
  } catch {
    res.status(503).json({
      message:
        "Shiprocket pickup addresses could not be loaded. Check the API connection and try again.",
    })
  }
}
