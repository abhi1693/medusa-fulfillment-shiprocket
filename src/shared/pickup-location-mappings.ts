import { createHash } from "node:crypto"
import { z } from "@medusajs/framework/zod"
import { MedusaError } from "@medusajs/framework/utils"
import { updateStockLocationsWorkflow } from "@medusajs/medusa/core-flows"
import { shiprocketConnectionScope } from "./connection"
import { readPickupCatalog, type PickupCatalog } from "./pickup-catalog"
const common = {
  location_id: z.string().min(1).max(128),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.string().regex(/^[a-f0-9]{64}$/),
}
export const pickupMappingInput = z.discriminatedUnion("action", [
  z
    .object({
      ...common,
      action: z.literal("create"),
      pickup_id: z
        .string()
        .regex(/^[1-9]\d*$/)
        .max(32),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("update"),
      pickup_id: z
        .string()
        .regex(/^[1-9]\d*$/)
        .max(32),
    })
    .strict(),
  z.object({ ...common, action: z.literal("remove") }).strict(),
])
const fields = [
  "id",
  "name",
  "updated_at",
  "metadata",
  "fulfillment_providers.id",
]
const metadata = (value: any) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {}
function linkedId(location: any) {
  const id = metadata(location.metadata).shiprocket_pickup_id
  return id == null || id === "" ? "" : String(id).slice(0, 128)
}
export function pickupMappingRevision(location: any) {
  const value = metadata(location.metadata)
  return createHash("sha256")
    .update(
      JSON.stringify([
        location.id,
        location.updated_at ?? null,
        value.shiprocket_pickup_id ?? null,
        value.shiprocket_pickup_scope ?? null,
      ])
    )
    .digest("hex")
}
function project(location: any, catalog: PickupCatalog) {
  const pickup_id = linkedId(location),
    bound = metadata(location.metadata).shiprocket_pickup_scope
  const scope_matches = !bound || bound === catalog.scope
  return {
    id: String(location.id),
    name: String(location.name || location.id),
    revision: pickupMappingRevision(location),
    pickup_id: pickup_id || null,
    scope_matches,
    status: !pickup_id
      ? "unmapped"
      : !scope_matches
        ? "different_connection"
        : catalog.pickups.some((p) => p.id === pickup_id)
          ? "mapped"
          : "pickup_missing",
    provider_linked:
      Array.isArray(location.fulfillment_providers) &&
      location.fulfillment_providers.some((p: any) =>
        String(p.id).startsWith("shiprocket_")
      ),
  }
}
async function locations(container: any, id?: string) {
  const result = await container
    .resolve("query")
    .graph({ entity: "stock_location", fields, filters: id ? { id } : {} })
  return result.data as any[]
}
export async function readPickupMappings(
  container: any,
  read = readPickupCatalog
) {
  const [catalog, rows] = await Promise.all([
    read(container),
    locations(container),
  ])
  return {
    ...catalog,
    locations: rows
      .map((row) => project(row, catalog))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  }
}
const conflict = () =>
  new MedusaError(
    MedusaError.Types.CONFLICT,
    "The pickup mapping or connection changed. Reload the table before saving."
  )
const updateLocations = (container: any, input: any) =>
  updateStockLocationsWorkflow(container).run({ input })
export async function changePickupMapping(
  container: any,
  raw: unknown,
  read = readPickupCatalog,
  update: (container: any, input: any) => Promise<unknown> = updateLocations
) {
  const input = pickupMappingInput.parse(raw)
  return container
    .resolve("locking")
    .execute(`shiprocket:pickup-mapping:${input.location_id}`, async () => {
      const [location] = await locations(container, input.location_id)
      if (!location || location.id !== input.location_id)
        throw new MedusaError(
          MedusaError.Types.NOT_FOUND,
          "Stock location not found"
        )
      if (
        pickupMappingRevision(location) !== input.revision ||
        (await shiprocketConnectionScope(container)) !== input.scope
      )
        throw conflict()
      const hasMapping = Boolean(linkedId(location))
      if (
        (input.action === "create" && hasMapping) ||
        (input.action !== "create" && !hasMapping)
      )
        throw conflict()
      if (input.action !== "remove") {
        const catalog = await read(container)
        if (catalog.scope !== input.scope) throw conflict()
        if (!catalog.pickups.some((p) => p.id === input.pickup_id))
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            "That pickup address is no longer available. Refresh the table."
          )
      }
      if ((await shiprocketConnectionScope(container)) !== input.scope)
        throw conflict()
      const [fresh] = await locations(container, input.location_id)
      if (
        !fresh ||
        fresh.id !== input.location_id ||
        pickupMappingRevision(fresh) !== input.revision
      )
        throw conflict()
      await update(container, {
        selector: { id: location.id },
        update: {
          metadata: {
            shiprocket_pickup_id:
              input.action === "remove" ? null : input.pickup_id,
            shiprocket_pickup_scope:
              input.action === "remove" ? null : input.scope,
          },
        },
      })
      const [saved] = await locations(container, input.location_id)
      const expected = input.action === "remove" ? "" : input.pickup_id
      if (
        !saved ||
        saved.id !== input.location_id ||
        linkedId(saved) !== expected ||
        (expected &&
          metadata(saved.metadata).shiprocket_pickup_scope !== input.scope)
      )
        throw conflict()
      return {
        location_id: location.id,
        revision: pickupMappingRevision(saved),
      }
    })
}
