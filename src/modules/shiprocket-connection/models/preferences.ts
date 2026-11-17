import { model } from "@medusajs/framework/utils"
export const ShiprocketPreferences = model.define("shiprocket_preferences", {
  id: model.id().primaryKey(),
  settings: model.json(),
  assignment_secret_ciphertext: model.text(),
  webhook_token_ciphertext: model.text().nullable(),
  revision: model.number(),
  updated_by: model.text(),
})
