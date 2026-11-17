import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import {
  readPickupMappings,
  changePickupMapping,
} from "../../../shared/pickup-location-mappings"
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  res.setHeader("Cache-Control", "private, no-store")
  res.json(await readPickupMappings(req.scope))
}
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  res.setHeader("Cache-Control", "private, no-store")
  res.json(await changePickupMapping(req.scope, req.validatedBody))
}
