import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules } from "@medusajs/framework/utils"

/**
 * Subscriber for Shiprocket tracking updates.
 * 
 * Listens to shiprocket.tracking.updated event emitted by the webhook handler.
 * Can be used to sync fulfillment status in Medusa when shipment is delivered.
 */
export default async function shiprocketTrackingUpdatedHandler({
    event,
    container,
}: SubscriberArgs<{
    awb: string
    tracking_id: string
    current_status: string
    shipment_status_id: number
}>) {
    const logger = container.resolve("logger")
    const { awb, current_status, shipment_status_id } = event.data

    logger.info(
        `Shiprocket tracking subscriber: AWB ${awb} status updated to ${current_status}`
    )

    // Shiprocket status IDs:
    // 7 = DELIVERED
    // 8 = DELIVERY ATTEMPTED
    // 9 = RTO INITIATED
    // 10 = RTO DELIVERED
    const DELIVERED_STATUS_ID = 7

    if (shipment_status_id === DELIVERED_STATUS_ID) {
        logger.info(`Shiprocket: Shipment ${awb} marked as DELIVERED`)

        // TODO: Optionally update Medusa fulfillment status
        // This would require finding the fulfillment by AWB and updating it
        // const fulfillmentService = container.resolve(Modules.FULFILLMENT)
        // ... update fulfillment status
    }
}

export const config: SubscriberConfig = {
    event: "shiprocket.tracking.updated",
}
