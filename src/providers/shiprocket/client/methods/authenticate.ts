import { MedusaError } from "@medusajs/framework/utils"
import type { AxiosInstance } from "axios"
import { handleError } from "../handle-error"
import type { ShiprocketAuthResponse } from "../types"

/**
 * Authenticates with the Shiprocket API to get a token.
 * Token is valid for 10 days per Shiprocket docs.
 */
export async function authenticate(
  axios: AxiosInstance,
  email: string,
  password: string,
  isDisposed: boolean
): Promise<{ token: string; tokenExpiry: number }> {
  if (isDisposed) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "Cannot authenticate: client is disposed"
    )
  }

  try {
    const response = await axios.post<ShiprocketAuthResponse>("/auth/login", {
      email,
      password,
    })

    if (!response.data?.token) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Shiprocket authentication failed: no token received"
      )
    }

    return {
      token: response.data.token,
      // Token valid for 10 days, refresh proactively after 8 days
      tokenExpiry: Date.now() + 8 * 24 * 60 * 60 * 1000,
    }
  } catch (error: unknown) {
    // If it's already a MedusaError, rethrow it
    if (error instanceof MedusaError) {
      throw error
    }
    // Otherwise, let handleError process the API error
    handleError(error, { operation: "authenticate" })
  }
}
