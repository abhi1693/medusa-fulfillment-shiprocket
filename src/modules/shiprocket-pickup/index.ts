import { Module } from "@medusajs/framework/utils"
import service from "./service"
export const SHIPROCKET_PICKUP_MODULE = "shiprocketPickup"
export default Module(SHIPROCKET_PICKUP_MODULE, { service })
