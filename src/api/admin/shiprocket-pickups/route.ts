import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { getShiprocketManager } from "../../../providers/shiprocket/client/manager"
import { shiprocketApiUrl } from "../../../providers/shiprocket/client/config"
import { pickupRows, pickupScope } from "../../../shared/pickup-mapping"
export async function GET(req: MedusaRequest, res: MedusaResponse) {
 try {
  const response = await (await getShiprocketManager(req.scope.resolve("logger")).getAxios()).get("/settings/company/pickup")
  const pickups = pickupRows(response.data).filter(row => /^[1-9]\d*$/.test(String(row.id))).map(row => ({
   id: String(row.id), nickname: String(row.pickup_location || row.pickup_code || ""),
   address: String(row.address || ""), address_2: String(row.address_2 || ""),
   city: String(row.city || ""), state: String(row.state || ""), country: String(row.country || ""),
   postcode: String(row.pin_code || "")
  }))
  res.json({ pickups, scope: pickupScope(shiprocketApiUrl(), process.env.SHIPROCKET_EMAIL || ""), mode: process.env.SHIPROCKET_MODE || "test" })
 } catch { res.status(503).json({ message: "Shiprocket pickup addresses could not be loaded. Check the API connection and try again." }) }
}
