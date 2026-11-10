/**
 * Types for Shiprocket webhook payloads.
 */

export interface ShiprocketWebhookScan {
    date: string
    status: string
    activity: string
    location: string
    "sr-status": string
    "sr-status-label": string
}

export interface ShiprocketWebhookPayload {
    awb: string
    courier_name: string
    current_status: string
    current_status_id: number
    shipment_status: string
    shipment_status_id: number
    current_timestamp: string // "DD MM YYYY HH:mm:ss"
    order_id: string // e.g., "1373900_150876814"
    sr_order_id: number
    awb_assigned_date?: string // "YYYY-MM-DD HH:mm:ss"
    pickup_scheduled_date?: string
    etd?: string // Estimated time of delivery
    scans: ShiprocketWebhookScan[]
    is_return: 0 | 1
    channel_id?: number
    pod_status?: string
    pod?: string
}
