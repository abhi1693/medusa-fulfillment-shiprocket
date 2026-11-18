import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import type ShiprocketConnectionService from "../../../../modules/shiprocket-connection/service"
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  res.setHeader("Cache-Control", "private, no-store")
  res.json(
    await req.scope
      .resolve<ShiprocketConnectionService>("shiprocketConnection")
      .verify(req.validatedBody as any, req.auth_context.actor_id)
  )
}
