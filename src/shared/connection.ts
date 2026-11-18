import { pickupScope } from "./pickup-mapping"
import { shiprocketApiUrl } from "../providers/shiprocket/client/config"
import type { Connection } from "../modules/shiprocket-connection/service"
export async function shiprocketConnection(
  container: any
): Promise<Connection> {
  return container.resolve("shiprocketConnection").runtime()
}
export async function shiprocketConnectionScope(container: any) {
  const connection = await shiprocketConnection(container)
  return pickupScope(shiprocketApiUrl(connection.mode), connection.email)
}
