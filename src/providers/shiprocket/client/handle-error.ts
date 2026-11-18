import { MedusaError } from "@medusajs/framework/utils"
import type { AxiosError, ShiprocketError } from "./types"

/**
 * Shiprocket API Error Codes (from docs):
 * - 200, 202: OK / Accepted
 * - 400: Bad Request - Invalid request or data
 * - 401: Unauthorized - Token/credentials invalid
 * - 404: Not Found - Resource doesn't exist
 * - 405: Method Not Allowed - Wrong HTTP method
 * - 422: Unprocessable Entity - Syntax error or cannot be fulfilled
 * - 429: Too Many Requests - Rate limit exceeded
 * - 500, 502, 503, 504: Server Errors
 */

interface ErrorContext {
  operation?: string
  orderId?: string
  shipmentId?: string
}

/**
 * Shiprocket field-level validation errors echo back the submitted values, which
 * for this integration include customer name, email, phone and addresses. Those
 * messages flow into logs and, via MedusaError, can reach the storefront. Report
 * only the FIELD names so the failure is still diagnosable without carrying PII.
 */
const PII_FIELD_PATTERN =
  /(name|email|phone|mobile|address|street|city|state|pincode|zip|contact|person|recipient|company)/i

function summarizeValidationErrors(errors: Record<string, unknown>): {
  fieldCount: number
  fields: string[]
} {
  const fields = Object.keys(errors)
  const safeFields = fields.map((f) =>
    PII_FIELD_PATTERN.test(f) ? "[redacted-field]" : f
  )
  return { fieldCount: fields.length, fields: safeFields }
}

/**
 * Handles Shiprocket API errors and converts them to MedusaError with appropriate types
 * @param error - The Axios error from the API call
 * @param context - Optional context about the operation for better error messages
 */
export function handleError(error: unknown, context?: ErrorContext): never {
  const axiosError = error as AxiosError<ShiprocketError>
  const statusCode = axiosError?.response?.status || 0
  const responseData = axiosError?.response?.data

  // Extract error message from Shiprocket response. Upstream messages can echo
  // submitted customer values, so only use short allowlisted messages verbatim.
  const rawMessage =
    typeof responseData?.message === "string" ? responseData.message : ""
  let message =
    rawMessage.length > 0 &&
    rawMessage.length <= 200 &&
    !PII_FIELD_PATTERN.test(rawMessage)
      ? rawMessage
      : axiosError?.message && axiosError.message.length <= 200
        ? "Shiprocket request failed"
        : "Unknown Shiprocket error"

  // Add context to message if available
  const contextStr = context?.operation ? `[${context.operation}]` : ""

  // Handle validation errors (field-level errors from Shiprocket).
  // Do NOT interpolate the upstream messages: they contain the submitted
  // values (customer PII). Only report which fields failed.
  if (responseData?.errors && typeof responseData.errors === "object") {
    const { fieldCount, fields } = summarizeValidationErrors(
      responseData.errors as Record<string, unknown>
    )
    message = `Validation failed on ${fieldCount} field(s): ${fields.join(", ")}`
  }

  // Map HTTP status codes to appropriate MedusaError types
  switch (statusCode) {
    case 401:
      throw new MedusaError(
        MedusaError.Types.UNAUTHORIZED,
        `${contextStr} Shiprocket authentication failed. Please verify your API credentials.`
      )

    case 404:
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `${contextStr} ${message}`
      )

    case 429:
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `${contextStr} Shiprocket rate limit exceeded. Please retry after a few seconds.`
      )

    case 400:
    case 422:
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `${contextStr} ${message}`
      )

    case 405:
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `${contextStr} Invalid API method. This may indicate a plugin bug.`
      )

    case 500:
    case 502:
    case 503:
    case 504:
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `${contextStr} Shiprocket server error (${statusCode}). Please try again later.`
      )

    default:
      // Network errors or unknown status codes
      if (axiosError?.code === "ECONNABORTED") {
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          `${contextStr} Shiprocket request timed out. ${context?.operation === "create" ? "Check existing shipments before retrying fulfillment." : "Please try again."}`
        )
      }

      if (
        axiosError?.code === "ENOTFOUND" ||
        axiosError?.code === "ECONNREFUSED"
      ) {
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          `${contextStr} Unable to connect to Shiprocket. Please check your network connection.`
        )
      }

      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `${contextStr} ${message}`
      )
  }
}
