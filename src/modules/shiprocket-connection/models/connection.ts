import { model } from "@medusajs/framework/utils"
export const ShiprocketConnection = model.define("shiprocket_connection", {
  id: model.id().primaryKey(),
  email: model.text(),
  mode: model.enum(["test", "live"]),
  password_ciphertext: model.text(),
  revision: model.number(),
  verified_at: model.dateTime(),
  updated_by: model.text(),
})
