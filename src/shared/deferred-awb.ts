import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto"
export function assignmentSecret(
  value = process.env.SHIPROCKET_ASSIGNMENT_SECRET ?? process.env.JWT_SECRET
): string {
  if (!value || value.length < 32)
    throw Error(
      "Manual AWB assignment requires an assignment secret of at least 32 characters"
    )
  return value
}
export function sealAssignment(
  value: any,
  fulfillmentId: string,
  secret: string
): string {
  if (!fulfillmentId)
    throw Error("A native fulfillment ID is required for manual AWB assignment")
  const iv = randomBytes(12),
    key = createHash("sha256").update(assignmentSecret(secret)).digest()
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(fulfillmentId))
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ])
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".")
}
export function openAssignment(
  value: unknown,
  fulfillmentId: string,
  secret: string
): any {
  try {
    if (typeof value !== "string" || value.length > 200000) throw Error()
    const [version, nonce, tag, data, extra] = value.split(".")
    if (version !== "v1" || extra || !data) throw Error()
    const key = createHash("sha256").update(assignmentSecret(secret)).digest()
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(nonce, "base64url")
    )
    decipher.setAAD(Buffer.from(fulfillmentId))
    decipher.setAuthTag(Buffer.from(tag, "base64url"))
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(data, "base64url")),
        decipher.final(),
      ]).toString()
    )
  } catch {
    throw Error(
      "The saved AWB assignment context could not be verified. Review this shipment before assigning an AWB."
    )
  }
}
export class DeferredAwbError extends Error {
  uncertain: boolean
  constructor(message: string, uncertain = false) {
    super(message)
    this.uncertain = uncertain
  }
}
