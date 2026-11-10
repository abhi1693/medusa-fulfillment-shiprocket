import { model } from "@medusajs/framework/utils"

/**
 * ShiprocketTracking model stores webhook data from Shiprocket.
 * Used to display live tracking status on storefront and admin.
 */
export const ShiprocketTracking = model.define("shiprocket_tracking", {
    id: model.id().primaryKey(),

    // Shiprocket identifiers
    awb: model.text().index("IDX_shiprocket_tracking_awb"),
    order_id: model.text().nullable(), // e.g., "1373900_150876814"
    sr_order_id: model.bigNumber().nullable(), // Shiprocket internal order ID

    // Link to Medusa
    // `.index()` is not available on the nullable modifier; add the index on the
    // non-nullable text property so the generated DDL keeps the index.
    medusa_fulfillment_id: model.text().index("idx_shiprocket_tracking_fulfillment").nullable(),
    medusa_order_id: model.text().nullable(),

    // Courier info
    courier_name: model.text().nullable(),

    // Status
    current_status: model.text().index("IDX_shiprocket_tracking_current_status"), // e.g., "IN TRANSIT", "DELIVERED"
    current_status_id: model.number().nullable(),
    shipment_status: model.text().nullable(),
    shipment_status_id: model.number().nullable(),

    // Timestamps from Shiprocket
    current_timestamp: model.dateTime().nullable(),
    etd: model.dateTime().nullable(), // Estimated time of delivery
    awb_assigned_date: model.dateTime().nullable(),
    pickup_scheduled_date: model.dateTime().nullable(),

    // Tracking history (array of scan events)
    scans: model.json().nullable(),

    // Additional info
    pod_status: model.text().nullable(), // Proof of delivery status
    pod: model.text().nullable(), // POD URL/data
    is_return: model.boolean().nullable(),
    channel_id: model.bigNumber().nullable(),

    // Shipment details
    origin: model.text().nullable(),
    destination: model.text().nullable(),
    weight: model.text().nullable(),

    // Raw payload for debugging
    raw_payload: model.json().nullable(),
})
