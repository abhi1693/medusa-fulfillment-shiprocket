import { fulfillmentPickupMiddleware } from "./fulfillment-pickup-middleware"
import { defineMiddlewares } from "@medusajs/framework/http"

export default defineMiddlewares({
  routes: [
    {
      matcher: "/admin/orders/:id/fulfillments",
      method: "POST",
      middlewares: [fulfillmentPickupMiddleware],
    },
    {
      // Make delivery estimate endpoint public (no API key required)
      matcher: "/store/shiprocket/delivery-estimate",
      middlewares: [],
      bodyParser: { sizeLimit: "1kb" },
    },
    {
      // Shiprocket webhook endpoint must stay public and tightly size-limited.
      matcher: "/hooks/fulfillment/delivery-updates",
      middlewares: [],
      bodyParser: { sizeLimit: "64kb" },
    },
  ],
})
