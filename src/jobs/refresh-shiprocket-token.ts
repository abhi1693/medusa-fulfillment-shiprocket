import { shiprocketConnection } from "../shared/connection"
import type { MedusaContainer } from "@medusajs/framework/types"
import {
  getShiprocketManager,
  hasShiprocketCredentials,
} from "../providers/shiprocket/client/manager"

/**
 * Scheduled job to proactively refresh Shiprocket authentication token.
 *
 * Runs every 8 days to ensure token stays fresh.
 * The token is cached in the singleton client manager.
 */
export default async function refreshShiprocketTokenJob(
  container: MedusaContainer
) {
  const logger = container.resolve("logger")

  try {
    const manager = getShiprocketManager(
      logger,
      await shiprocketConnection(container)
    )
    await manager.forceRefreshToken()
    logger.info("Shiprocket token refreshed successfully via scheduled job")
  } catch (err: any) {
    // Log message only. Passing the raw error object risks dumping an axios
    // error whose `config.data` holds the Shiprocket login body (email/password)
    // and whose `config.headers` holds the bearer token.
    logger.error(
      `Failed to refresh Shiprocket token: ${err instanceof Error ? err.message : "unknown error"}`
    )
  }
}

export const config = {
  name: "refresh-shiprocket-token",
  schedule: "0 0 */8 * *", // every 8 days at 00:00
}
