import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import ShipRocketFulfillmentProviderService from "./service"

export default ModuleProvider(Modules.FULFILLMENT, {
    services: [ShipRocketFulfillmentProviderService],
})