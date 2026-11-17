import { Migration } from "@medusajs/framework/mikro-orm/migrations"
export class Migration20261117000000 extends Migration {
  override async up() {
    this.addSql(`create table if not exists "shiprocket_connection" (
      "id" text primary key check (id = 'shiprocket'), "email" text not null,
      "mode" text not null check (mode in ('test','live')), "password_ciphertext" text not null,
      "revision" integer not null check (revision > 0), "verified_at" timestamptz not null,
      "updated_by" text not null, "created_at" timestamptz not null default now(),
      "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null check (deleted_at is null)
    );`)
  }
  override async down() {
    this.addSql('drop table if exists "shiprocket_connection";')
  }
}
