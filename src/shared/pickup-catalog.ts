import { MedusaError } from "@medusajs/framework/utils"
import { shiprocketConnection } from "./connection"
import { shiprocketApiUrl } from "../providers/shiprocket/client/config"
import { getShiprocketManager } from "../providers/shiprocket/client/manager"
import { pickupRows, pickupScope } from "./pickup-mapping"
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")
export async function readPickupCatalog(container: any) {
  const connection = await shiprocketConnection(container)
  try {
    const response = await (
      await getShiprocketManager(
        container.resolve("logger"),
        connection
      ).getAxios()
    ).get("/settings/company/pickup")
    const pickups = pickupRows(response.data)
      .filter(
        (row) =>
          (typeof row.id !== "number" || Number.isSafeInteger(row.id)) &&
          /^[1-9]\d*$/.test(String(row.id))
      )
      .map((row) => ({
        id: String(row.id),
        nickname: text(row.pickup_location) || text(row.pickup_code),
        address: text(row.address),
        address_2: text(row.address_2),
        city: text(row.city),
        state: text(row.state),
        country: text(row.country),
        postcode: String(row.pin_code ?? ""),
      }))
      .sort(
        (a, b) =>
          a.nickname.localeCompare(b.nickname) || a.id.localeCompare(b.id)
      )
    return {
      pickups,
      scope: pickupScope(shiprocketApiUrl(connection.mode), connection.email),
      mode: connection.mode,
    }
  } catch {
    container
      .resolve("logger")
      .warn(
        "Shiprocket pickup addresses could not be read for the current connection"
      )
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "Shiprocket pickup addresses could not be loaded. Check the API connection and try again."
    )
  }
}
export type PickupCatalog = Awaited<ReturnType<typeof readPickupCatalog>>
