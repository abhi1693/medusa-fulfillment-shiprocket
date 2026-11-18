import { defineLink } from "@medusajs/framework/utils"
import StockLocationModule from "@medusajs/medusa/stock-location"
import PickupModule from "../modules/shiprocket-pickup"

export default defineLink(StockLocationModule.linkable.stockLocation, {
  linkable: PickupModule.linkable.shiprocketPickup,
  isList: true,
})
