import { MedusaService } from "@medusajs/framework/utils"
import { ShiprocketTracking } from "./models/tracking"

/**
 * Service for managing Shiprocket tracking data.
 * Provides CRUD operations for webhook data storage and retrieval.
 */
class ShiprocketTrackingModuleService extends MedusaService({
    ShiprocketTracking,
}) {
    /**
     * Upsert tracking record by AWB number.
     * Creates new record if not exists, updates if exists.
     */
    async upsertByAwb(data: {
        awb: string
        order_id?: string
        medusa_order_id?: string
        sr_order_id?: number
        medusa_fulfillment_id?: string
        courier_name?: string
        current_status: string
        current_status_id?: number
        shipment_status?: string
        shipment_status_id?: number
        current_timestamp?: Date
        etd?: Date
        awb_assigned_date?: Date
        pickup_scheduled_date?: Date
        scans?: any[]
        pod_status?: string
        pod?: string
        is_return?: boolean
        channel_id?: number
        raw_payload?: any
    }) {
        // Try to find existing record by AWB
        const [existing] = await this.listShiprocketTrackings({
            awb: data.awb,
        }, {
            take: 1,
        })

        if (existing) {
            // Update existing record - mutable status fields plus linkage/courier
            // fields (first webhook must not win forever; stale medusa_order_id
            // would corrupt ownership checks).
            const updateData: any = {
                id: existing.id,
                current_status: data.current_status,
                current_status_id: data.current_status_id,
                shipment_status: data.shipment_status,
                shipment_status_id: data.shipment_status_id,
                current_timestamp: data.current_timestamp,
                etd: data.etd,
                awb_assigned_date: data.awb_assigned_date,
                pickup_scheduled_date: data.pickup_scheduled_date,
                scans: data.scans,
                pod_status: data.pod_status,
                pod: data.pod,
                raw_payload: data.raw_payload,
                order_id: data.order_id,
                medusa_order_id: data.medusa_order_id,
                medusa_fulfillment_id: data.medusa_fulfillment_id,
                sr_order_id: data.sr_order_id,
                courier_name: data.courier_name,
                channel_id: data.channel_id,
                is_return: data.is_return,
            }

            // Remove undefined fields to avoid overwriting with nothing
            Object.keys(updateData).forEach(key => updateData[key] === undefined && delete updateData[key]);

            const updated = await this.updateShiprocketTrackings([updateData])
            return updated[0]
        } else {
            // Create new record
            return await this.createShiprocketTrackings(data as any)
        }
    }

    /**
     * Find tracking by AWB number.
     */
    async findByAwb(awb: string) {
        const [result] = await this.listShiprocketTrackings({
            awb,
        }, {
            take: 1,
        })
        return result || null
    }

    /**
     * Find tracking by Medusa fulfillment ID.
     */
    async findByFulfillmentId(fulfillmentId: string) {
        const [result] = await this.listShiprocketTrackings({
            medusa_fulfillment_id: fulfillmentId,
        }, {
            take: 1,
        })
        return result || null
    }
}

export default ShiprocketTrackingModuleService
