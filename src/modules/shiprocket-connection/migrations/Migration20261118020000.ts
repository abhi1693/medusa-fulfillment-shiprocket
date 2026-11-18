import { Migration } from "@medusajs/framework/mikro-orm/migrations"
import { defaultOperationalSettings } from "../../../shared/operational-settings"
import { sealPassword } from "../service"
export class Migration20261118020000 extends Migration {
  override async up() {
    // Preserve existing deferred-AWB envelopes signed with the deployment bootstrap key.
    const secret = process.env.JWT_SECRET
    if (!secret || secret.length < 32)
      throw Error("JWT_SECRET of at least 32 characters is required")
    const ciphertext = sealPassword(secret, "shiprocket-preferences:assignment")
    const settings = JSON.stringify(defaultOperationalSettings())
    this.addSql(
      'alter table "shiprocket_preferences" add column if not exists "assignment_secret_ciphertext" text null;'
    )
    this
      .addSql(`insert into shiprocket_preferences (id,settings,assignment_secret_ciphertext,revision,updated_by)
      values ('shiprocket','${settings}'::jsonb,'${ciphertext}',1,'system:shiprocket-settings-initialize')
      on conflict (id) do update set assignment_secret_ciphertext=coalesce(shiprocket_preferences.assignment_secret_ciphertext,excluded.assignment_secret_ciphertext);`)
    this.addSql(
      'alter table "shiprocket_preferences" alter column "assignment_secret_ciphertext" set not null;'
    )
  }
  override async down() {
    this.addSql(
      'alter table "shiprocket_preferences" drop column if exists "assignment_secret_ciphertext";'
    )
  }
}
