import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration20260408091000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_shiprocket_tracking_medusa_order_id" ON "shiprocket_tracking" ("medusa_order_id") WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_shiprocket_tracking_current_status" ON "shiprocket_tracking" ("current_status") WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_shiprocket_tracking_created_at" ON "shiprocket_tracking" ("created_at") WHERE deleted_at IS NULL;`)
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS "IDX_shiprocket_tracking_medusa_order_id";`)
    this.addSql(`DROP INDEX IF EXISTS "IDX_shiprocket_tracking_current_status";`)
    this.addSql(`DROP INDEX IF EXISTS "IDX_shiprocket_tracking_created_at";`)
  }
}
