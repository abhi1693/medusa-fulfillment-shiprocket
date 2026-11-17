import {
  operationalSave,
  operationalSettings,
  type OperationalSettings,
} from "../../shared/operational-settings"
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"
import axios from "axios"
import { MedusaError } from "@medusajs/framework/utils"
import { z } from "@medusajs/framework/zod"
import {
  shiprocketApiUrl,
  shiprocketTimeout,
} from "../../providers/shiprocket/client/config"
export const connectionInput = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().max(1024).optional(),
    mode: z.enum(["test", "live"]),
    revision: z.number().int().nonnegative(),
  })
  .strict()
export const connectionSave = connectionInput
  .extend({ verification: z.string().min(1).max(4096) })
  .strict()
export type ConnectionInput = z.infer<typeof connectionInput>
export type Connection = Partial<OperationalSettings> & {
  email: string
  password: string
  mode: "test" | "live"
  assignment_secret?: string
}
const invalid = (message: string) =>
  new MedusaError(MedusaError.Types.INVALID_DATA, message)
const conflict = () =>
  new MedusaError(
    MedusaError.Types.CONFLICT,
    "Shiprocket settings changed. Reload and verify again."
  )
function key() {
  const secret = process.env.JWT_SECRET
  if (!secret || secret.length < 32)
    throw invalid(
      "Shiprocket credential encryption requires JWT_SECRET of at least 32 characters"
    )
  return createHash("sha256")
    .update("shiprocket-connection:v1:" + secret)
    .digest()
}
export function sealPassword(
  password: string,
  context = "shiprocket-connection:shiprocket"
) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv)
  cipher.setAAD(Buffer.from(context))
  const encrypted = Buffer.concat([
    cipher.update(password, "utf8"),
    cipher.final(),
  ])
  return [iv, cipher.getAuthTag(), encrypted]
    .map((v) => v.toString("base64url"))
    .join(".")
}
export function openPassword(
  value: string,
  context = "shiprocket-connection:shiprocket"
) {
  const [iv, tag, encrypted] = value
    .split(".")
    .map((v) => Buffer.from(v, "base64url"))
  const decipher = createDecipheriv("aes-256-gcm", key(), iv)
  decipher.setAAD(Buffer.from(context))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8"
  )
}
function digest(value: unknown) {
  return createHmac("sha256", key())
    .update(JSON.stringify(value))
    .digest("base64url")
}
export default class ShiprocketConnectionService {
  private db: any
  constructor({ manager }: { manager: { getKnex(): any } }) {
    this.db = manager.getKnex()
  }
  private async row() {
    return this.db("shiprocket_connection").where({ id: "shiprocket" }).first()
  }
  private async preferencesRow() {
    const row = await this.db("shiprocket_preferences")
      .where({ id: "shiprocket" })
      .first()
    if (!row)
      throw invalid(
        "Shiprocket settings are not initialized. Run database migrations."
      )
    return row
  }
  async runtimeSettings(): Promise<OperationalSettings> {
    const row = await this.preferencesRow()
    return operationalSettings.parse(row.settings)
  }
  async webhookToken(): Promise<string | undefined> {
    const row = await this.preferencesRow()
    return row.webhook_token_ciphertext
      ? openPassword(
          row.webhook_token_ciphertext,
          "shiprocket-preferences:webhook"
        )
      : undefined
  }
  async preferences() {
    const row = await this.preferencesRow()
    return {
      configured: true,
      revision: row.revision,
      settings: operationalSettings.parse(row.settings),
      webhook_token_configured: Boolean(row.webhook_token_ciphertext),
      updated_at: new Date(row.updated_at).toISOString(),
    }
  }

  async savePreferences(raw: unknown, actor: string) {
    const input = operationalSave.parse(raw)
    if (!(await this.row()))
      throw invalid(
        "Save verified credentials before changing shipping settings"
      )
    const row = await this.preferencesRow()
    if ((row?.revision ?? 0) !== input.revision) throw conflict()
    const token = input.webhook_token || (await this.webhookToken())
    if (token && (token.length < 32 || token.length > 1024))
      throw invalid("Webhook token must contain 32 to 1024 characters")
    if (input.settings.enabled && !token)
      throw invalid("Configure a webhook token before enabling Shiprocket")
    const result = await this.db.raw(
      `update shiprocket_preferences set settings=?::jsonb, webhook_token_ciphertext=?,
       updated_by=?, revision=revision+1, updated_at=now() where id='shiprocket' and revision=? returning id`,
      [
        JSON.stringify(input.settings),
        token ? sealPassword(token, "shiprocket-preferences:webhook") : null,
        actor,
        input.revision,
      ]
    )
    if (!result.rows?.length) throw conflict()
    return this.preferences()
  }
  async read() {
    const row = await this.row()
    return row
      ? {
          configured: true,
          email: row.email,
          mode: row.mode,
          revision: row.revision,
          verified_at: new Date(row.verified_at).toISOString(),
        }
      : {
          configured: false,
          email: "",
          mode: "test",
          revision: 0,
          verified_at: null,
        }
  }
  async runtime(): Promise<Connection> {
    const row = await this.row()
    const settings = await this.runtimeSettings()
    if (!row)
      throw invalid(
        "Configure and verify Shiprocket credentials in Admin settings first"
      )
    const preferences = await this.preferencesRow()
    return {
      ...settings,
      assignment_secret: openPassword(
        preferences.assignment_secret_ciphertext,
        "shiprocket-preferences:assignment"
      ),
      email: row.email,
      mode: row.mode,
      password: openPassword(row.password_ciphertext),
    }
  }
  private async candidate(input: ConnectionInput) {
    const row = await this.row()
    if ((row?.revision ?? 0) !== input.revision) throw conflict()
    const password =
      input.password || (row && openPassword(row.password_ciphertext))
    if (!password) throw invalid("Shiprocket API password is required")
    return { email: input.email, password, mode: input.mode }
  }
  async verify(raw: ConnectionInput, actor: string) {
    const input = connectionInput.parse(raw),
      candidate = await this.candidate(input)
    try {
      const response = await axios.post(
        shiprocketApiUrl(candidate.mode) + "/auth/login",
        { email: candidate.email, password: candidate.password },
        {
          timeout: (await this.runtimeSettings()).timeout,
          maxRedirects: 0,
          headers:
            candidate.mode === "test"
              ? {
                  Origin: "https://sandbox.shiprocket.in",
                  Referer: "https://sandbox.shiprocket.in",
                }
              : {},
        }
      )
      if (
        typeof response.data?.token !== "string" ||
        !response.data.token.trim()
      )
        throw Error("No token")
    } catch {
      throw invalid(
        "Shiprocket verification failed. Check the API-user email, password and selected mode, then retry."
      )
    }
    const verified_at = new Date().toISOString(),
      expires = Date.now() + 300000
    const payload = Buffer.from(
      JSON.stringify({
        actor,
        revision: input.revision,
        credentials: digest(candidate),
        verified_at,
        expires,
      })
    ).toString("base64url")
    return {
      verified: true,
      verified_at,
      verification: payload + "." + digest(payload),
      expires_at: new Date(expires).toISOString(),
    }
  }
  async save(raw: unknown, actor: string) {
    const { verification, ...input } = connectionSave.parse(raw),
      candidate = await this.candidate(input)
    try {
      const [payload, signature, ...extra] = verification.split(".")
      const a = Buffer.from(signature || ""),
        b = Buffer.from(digest(payload))
      if (extra.length || a.length !== b.length || !timingSafeEqual(a, b))
        throw Error()
      const proof = JSON.parse(Buffer.from(payload, "base64url").toString())
      if (
        proof.actor !== actor ||
        proof.revision !== input.revision ||
        proof.credentials !== digest(candidate) ||
        proof.expires < Date.now()
      )
        throw Error()
      const result = await this.db.raw(
        `insert into shiprocket_connection (id,email,mode,password_ciphertext,revision,verified_at,updated_by)
        values ('shiprocket',?,?,?,1,?,?) on conflict (id) do update set email=excluded.email, mode=excluded.mode,
        password_ciphertext=excluded.password_ciphertext,revision=shiprocket_connection.revision+1,
        verified_at=excluded.verified_at,updated_by=excluded.updated_by,updated_at=now()
        where shiprocket_connection.revision=? returning id`,
        [
          candidate.email,
          candidate.mode,
          sealPassword(candidate.password),
          proof.verified_at,
          actor,
          input.revision,
        ]
      )
      if (!result.rows?.length) throw conflict()
    } catch (error) {
      if (error instanceof MedusaError) throw error
      throw invalid("Verify these exact credentials again before saving")
    }
    return this.read()
  }
}
