import { model } from "@medusajs/framework/utils"
export const ShiprocketPickup = model
  .define("shiprocket_pickup", {
    id: model.id().primaryKey(),
    scope: model.text(),
    stock_location_id: model.text().index("IDX_shiprocket_pickup_location"),
    revision: model.text(),
    nickname: model.text().nullable(),
    external_id: model.text().nullable(),
    state: model.text(),
    last_error: model.text().nullable(),
    synced_at: model.dateTime().nullable(),
  })
  .indexes([
    {
      name: "IDX_shiprocket_pickup_revision",
      on: ["scope", "stock_location_id", "revision"],
      unique: true,
    },
  ])
