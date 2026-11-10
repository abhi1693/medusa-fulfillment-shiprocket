import type { MedusaContainer } from "@medusajs/framework/types"

const SHIPROCKET_TRACKING_MODULE = "shiprocketTrackingModuleService"

export default async function cleanupShiprocketWebhookPayloadsJob(container: MedusaContainer) {
  const logger = container.resolve("logger")
  const trackingService = container.resolve<any>(SHIPROCKET_TRACKING_MODULE)
  const rawRetention = Number(process.env.SHIPROCKET_WEBHOOK_PAYLOAD_RETENTION_DAYS ?? 30)
  const retentionDays = Number.isFinite(rawRetention)
    ? Math.min(Math.max(Math.floor(rawRetention), 1), 365)
    : 30
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)

  try {
    let totalCleared = 0
    // Loop in batches so backlogs larger than one page actually drain.
    for (let page = 0; page < 20; page++) {
      const [records] = await trackingService.listAndCountShiprocketTrackings(
        { created_at: { $lt: cutoff } },
        { take: 500, order: { created_at: "ASC" } }
      )

      const updates = (records || [])
        .filter((item: Record<string, unknown>) => !!item.raw_payload)
        .map((item: Record<string, unknown>) => ({
          id: item.id,
          raw_payload: null,
        }))

      if (!updates.length) {
        break
      }

      await trackingService.updateShiprocketTrackings(updates)
      totalCleared += updates.length
      if ((records || []).length < 500) {
        break
      }
    }
    if (totalCleared > 0) {
      logger.info(`[Shiprocket] Cleanup job cleared raw_payload for ${totalCleared} records older than ${retentionDays} days`)
    }
  } catch (error: any) {
    logger.error(`[Shiprocket] Cleanup webhook payload job failed: ${error.message}`)
  }
}

export const config = {
  name: "cleanup-shiprocket-webhook-payloads",
  schedule: "30 3 * * *",
}
