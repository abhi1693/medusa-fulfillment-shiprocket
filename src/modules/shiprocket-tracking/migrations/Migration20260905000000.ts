import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260905000000 extends Migration {

  override async up(): Promise<void> {
    // NOTE: intentionally NOT unique — duplicate AWB rows can already exist
    // from concurrent first-seen webhooks, which would fail a unique index
    // at deploy time. Dedupe legacy rows first, then promote to UNIQUE.
    this.addSql(`CREATE INDEX IF NOT EXISTS "idx_shiprocket_tracking_awb" ON "shiprocket_tracking" ("awb") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "idx_shiprocket_tracking_fulfillment" ON "shiprocket_tracking" ("medusa_fulfillment_id") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS "idx_shiprocket_tracking_awb";`);
    this.addSql(`DROP INDEX IF EXISTS "idx_shiprocket_tracking_fulfillment";`);
  }

}
