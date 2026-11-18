import { Migration } from "@medusajs/framework/mikro-orm/migrations"
export class Migration20261109000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "shiprocket_pickup" ("id" text not null, "scope" text not null, "stock_location_id" text not null, "revision" text not null, "nickname" text null, "external_id" text null, "state" text not null, "last_error" text null, "synced_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "shiprocket_pickup_pkey" primary key ("id"));`
    )
    this.addSql(
      `create unique index if not exists "IDX_shiprocket_pickup_revision" on "shiprocket_pickup" ("scope", "stock_location_id", "revision") where "deleted_at" is null;`
    )
    this.addSql(
      `create index if not exists "IDX_shiprocket_pickup_location" on "shiprocket_pickup" ("stock_location_id") where "deleted_at" is null;`
    )
  }
  override async down(): Promise<void> {
    this.addSql('drop table if exists "shiprocket_pickup" cascade;')
  }
}
