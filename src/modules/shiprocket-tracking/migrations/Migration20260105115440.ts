import { Migration } from '@medusajs/framework/mikro-orm/migrations';

export class Migration20260105115440 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "shiprocket_tracking" add column if not exists "medusa_order_id" text null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "shiprocket_tracking" drop column if exists "medusa_order_id";`);
  }

}
