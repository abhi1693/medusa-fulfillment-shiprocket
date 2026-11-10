import { Migration } from '@medusajs/framework/mikro-orm/migrations';

export class Migration20260105114550 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "shiprocket_tracking" ("id" text not null, "awb" text not null, "order_id" text null, "sr_order_id" numeric null, "medusa_fulfillment_id" text null, "courier_name" text null, "current_status" text not null, "current_status_id" integer null, "shipment_status" text null, "shipment_status_id" integer null, "current_timestamp" timestamptz null, "etd" timestamptz null, "awb_assigned_date" timestamptz null, "pickup_scheduled_date" timestamptz null, "scans" jsonb null, "pod_status" text null, "pod" text null, "is_return" boolean null, "channel_id" numeric null, "raw_payload" jsonb null, "raw_sr_order_id" jsonb null, "raw_channel_id" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "shiprocket_tracking_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_shiprocket_tracking_awb" ON "shiprocket_tracking" (awb) WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_shiprocket_tracking_deleted_at" ON "shiprocket_tracking" (deleted_at) WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "shiprocket_tracking" cascade;`);
  }

}
