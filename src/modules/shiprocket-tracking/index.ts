import ShiprocketTrackingModuleService from "./service"
import { Module } from "@medusajs/framework/utils"

/**
 * Shiprocket Tracking Module
 * 
 * Stores and manages shipment tracking data received from Shiprocket webhooks.
 * Provides APIs for querying tracking status by AWB or fulfillment ID.
 */
export const SHIPROCKET_TRACKING_MODULE = "shiprocketTrackingModuleService"

export default Module(SHIPROCKET_TRACKING_MODULE, {
    service: ShiprocketTrackingModuleService,
})
