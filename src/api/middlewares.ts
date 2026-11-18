import { operationalSave } from "../shared/operational-settings"
import { pickupMappingInput } from "../shared/pickup-location-mappings"
import {
  connectionInput,
  connectionSave,
} from "../modules/shiprocket-connection/service"
import {
  authenticate,
  validateAndTransformBody,
} from "@medusajs/framework/http"
import { fulfillmentPickupMiddleware } from "./fulfillment-pickup-middleware"
import { defineMiddlewares } from "@medusajs/framework/http"

export default defineMiddlewares({
  routes: [
    {
      matcher: "/admin/shiprocket-settings/preferences",
      method: "GET",
      middlewares: [authenticate("user", ["session", "bearer"])],
    },
    {
      matcher: "/admin/shiprocket-settings/preferences",
      method: "POST",
      bodyParser: { sizeLimit: "8kb" },
      middlewares: [
        authenticate("user", ["session", "bearer"]),
        validateAndTransformBody(operationalSave),
      ],
    },
    {
      matcher: "/admin/shiprocket-pickup-mappings",
      method: "GET",
      middlewares: [authenticate("user", ["session", "bearer"])],
    },
    {
      matcher: "/admin/shiprocket-pickup-mappings",
      method: "POST",
      bodyParser: { sizeLimit: "2kb" },
      middlewares: [
        authenticate("user", ["session", "bearer"]),
        validateAndTransformBody(pickupMappingInput),
      ],
    },
    {
      matcher: "/admin/shiprocket-settings",
      method: "GET",
      middlewares: [authenticate("user", ["session", "bearer"])],
    },
    {
      matcher: "/admin/shiprocket-settings",
      method: "POST",
      bodyParser: { sizeLimit: "8kb" },
      middlewares: [
        authenticate("user", ["session", "bearer"]),
        validateAndTransformBody(connectionSave),
      ],
    },
    {
      matcher: "/admin/shiprocket-settings/verify",
      method: "POST",
      bodyParser: { sizeLimit: "8kb" },
      middlewares: [
        authenticate("user", ["session", "bearer"]),
        validateAndTransformBody(connectionInput),
      ],
    },
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
