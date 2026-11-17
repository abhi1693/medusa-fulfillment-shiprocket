import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import type ShiprocketConnectionService from "../../../modules/shiprocket-connection/service"
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  res.setHeader("Cache-Control", "private, no-store")
  res.json(
    await req.scope
      .resolve<ShiprocketConnectionService>("shiprocketConnection")
      .read()
  )
}
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  res.setHeader("Cache-Control", "private, no-store")
  res.json(
    await req.scope
      .resolve<ShiprocketConnectionService>("shiprocketConnection")
      .save(req.validatedBody, req.auth_context.actor_id)
  )
}
