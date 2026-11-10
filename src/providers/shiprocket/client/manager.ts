import {
  courierPolicy,
  selectCourier,
  type CourierPolicy,
} from "../utils/courier-policy"
import axios from "axios"
import type { AxiosInstance } from "axios"
import { createHash, randomUUID } from "node:crypto"
import type { ShiprocketClientOptions } from "./types"
import http from "http"
import https from "https"
import { MedusaError } from "@medusajs/framework/utils"
import type { Logger } from "@medusajs/framework/types"
import {
  SHIPROCKET_DEFAULT_TIMEOUT_MS,
  shiprocketApiUrl,
  shiprocketRetryDelay,
} from "./config"

interface CachedToken {
  token: string
  expiresAt: number
}

interface CachedDeliveryEstimate {
  response: any
  expiresAt: number
}

type DeliveryPreference = CourierPolicy["selection"]

// Fallback logger for when Medusa logger is not available
const fallbackLogger: Logger = {
  debug: (msg: string) => {
    console.debug(`[Shiprocket] ${msg}`)
  },
  info: (msg: string) => {
    console.info(`[Shiprocket] ${msg}`)
  },
  warn: (msg: string) => {
    console.warn(`[Shiprocket] ${msg}`)
  },
  error: (msg: string) => {
    console.error(`[Shiprocket] ${msg}`)
  },
  silly: (msg: string) => {
    console.debug(`[Shiprocket] ${msg}`)
  },
  verbose: (msg: string) => {
    console.debug(`[Shiprocket] ${msg}`)
  },
  http: (msg: string) => {
    console.debug(`[Shiprocket] ${msg}`)
  },
  activity: (msg: string) => {
    console.log(`[Shiprocket] ${msg}`)
    return msg
  },
  progress: (activityId: string, msg: string) => {
    console.log(`[Shiprocket] [${activityId}] ${msg}`)
    return {}
  },
  failure: (activityId: string, msg: string) => {
    console.error(`[Shiprocket] [${activityId}] ${msg}`)
    return {}
  },
  success: (activityId: string, msg: string) => {
    console.log(`[Shiprocket] [${activityId}] ${msg}`)
    return {}
  },
  log: (...args: any[]) => {
    console.log("[Shiprocket]", ...args)
  },
  panic: (msg: Error) => {
    console.error(`[Shiprocket] PANIC:`, msg)
    throw msg
  },
  shouldLog: () => true,
  setLogLevel: () => {},
  unsetLogLevel: () => {},
}

const TOKEN_REFRESH_BUFFER_DAYS = 8 // Refresh 2 days before expiry (10 day token)
const DELIVERY_ESTIMATE_CACHE_HOURS = 4 // Cache estimates for 4 hours

/**
 * Singleton manager for Shiprocket API client.
 *
 * Key features:
 * - Caches authentication token (valid for 10 days, refreshes at 8 days)
 * - Uses HTTP keep-alive for connection reuse
 * - Thread-safe token refresh with mutex pattern
 * - Shared axios instance across all requests
 */
class ShiprocketClientManager {
  private static instances = new Map<string, ShiprocketClientManager>()

  private cachedToken: CachedToken | null = null
  private tokenRefreshPromise: Promise<void> | null = null
  private authRetryAt = 0
  private apiRetryAt = 0
  private authFailures = 0
  private axios: AxiosInstance
  private logger: Logger

  // Delivery estimate cache: key = "pickup-delivery-weight-cod"
  private deliveryEstimateCache: Map<string, CachedDeliveryEstimate> = new Map()
  private readonly maxCacheSize = 1000 // LRU cache limit

  private readonly email: string
  private readonly password: string
  private readonly mode: "test" | "live"
  private readonly deliveryPreference: DeliveryPreference
  private readonly courierPolicy: CourierPolicy

  /**
   * Get the singleton instance of ShiprocketClientManager.
   * Lazily initializes on first call.
   */
  static getInstance(
    logger?: Logger,
    options: ShiprocketClientOptions = {}
  ): ShiprocketClientManager {
    const mode =
      options.mode ??
      (process.env.SHIPROCKET_MODE as "test" | "live" | undefined) ??
      "test"
    const policy = courierPolicy(options)
    const timeout = options.timeout ?? SHIPROCKET_DEFAULT_TIMEOUT_MS
    if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 60000)
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Shiprocket timeout must be an integer from 1000 to 60000 milliseconds"
      )
    const resolved = {
      timeout,
      courier_selection: policy.selection,
      courier_fallback: policy.fallback,
      preferred_real_time_tracking: policy.preferred_real_time_tracking,
      preferred_pod: policy.preferred_pod,
      preferred_call_before_delivery: policy.preferred_call_before_delivery,
      require_real_time_tracking: policy.require_real_time_tracking,
      pod_requirement: policy.pod,
      require_call_before_delivery: policy.require_call_before_delivery,
      email: options.email ?? process.env.SHIPROCKET_EMAIL ?? "",
      password: options.password ?? process.env.SHIPROCKET_PASSWORD ?? "",
      mode,
    }
    const key = createHash("sha256")
      .update(JSON.stringify(resolved))
      .digest("hex")
    let instance = this.instances.get(key)
    if (!instance) {
      instance = new ShiprocketClientManager(logger, resolved)
      this.instances.set(key, instance)
    }
    return instance
  }

  static hasCredentials(options: ShiprocketClientOptions = {}): boolean {
    return !!(
      (options.email ?? process.env.SHIPROCKET_EMAIL) &&
      (options.password ?? process.env.SHIPROCKET_PASSWORD)
    )
  }

  static reset(): void {
    for (const instance of this.instances.values()) {
      instance.cachedToken = null
      instance.tokenRefreshPromise = null
    }
    this.instances.clear()
  }

  private constructor(logger?: Logger, options: ShiprocketClientOptions = {}) {
    this.mode = options.mode ?? "test"
    this.email = options.email ?? process.env.SHIPROCKET_EMAIL ?? ""
    this.password = options.password ?? process.env.SHIPROCKET_PASSWORD ?? ""
    this.courierPolicy = courierPolicy(options)
    this.deliveryPreference = this.courierPolicy.selection
    this.logger = logger || fallbackLogger

    if (!this.email || !this.password) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Shiprocket API-user email and password are required"
      )
    }

    // Create axios instance with keep-alive for connection reuse
    const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10 })
    const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 })

    this.axios = axios.create({
      baseURL: shiprocketApiUrl(this.mode),
      maxRedirects: 0,
      headers: {
        "Content-Type": "application/json",
        ...(this.mode === "test"
          ? {
              Origin: "https://sandbox.shiprocket.in",
              Referer: "https://sandbox.shiprocket.in",
            }
          : {}),
      },
      timeout: options.timeout ?? SHIPROCKET_DEFAULT_TIMEOUT_MS,
      httpAgent,
      httpsAgent,
    })

    const logRequest = (
      config: any,
      phase: "start" | "success" | "error",
      status?: number,
      code?: string
    ) => {
      if (!config || (phase !== "error" && !config.shiprocket_order_id)) return
      const endpoint = String(config.url || "")
        .split("?")[0]
        .replace(/(\/(?:show|shipments?|awb)\/)[^/]+/g, "$1:id")
      const record = {
        phase,
        trace_id: config.shiprocket_trace_id,
        order_id: /^order_[A-Za-z0-9]+$/.test(config.shiprocket_order_id || "")
          ? config.shiprocket_order_id
          : undefined,
        mode: this.mode,
        method: String(config.method || "get").toUpperCase(),
        endpoint,
        timeout_ms: config.timeout,
        duration_ms:
          phase === "start"
            ? undefined
            : Math.max(
                0,
                Date.now() - (config.shiprocket_started_at || Date.now())
              ),
        status,
        code,
      }
      this.logger[phase === "error" ? "warn" : "info"](
        "Shiprocket HTTP " + JSON.stringify(record)
      )
    }
    this.axios.interceptors.request.use((request) => {
      const traced = request as any
      traced.shiprocket_trace_id = randomUUID()
      traced.shiprocket_started_at = Date.now()
      logRequest(traced, "start")
      if (request.url !== "/auth/login" && Date.now() < this.apiRetryAt) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "Shiprocket request retry is delayed by rate limiting"
        )
      }
      return request
    })

    // Interceptor to handle 401 Unauthorized - auto-refresh token
    this.axios.interceptors.response.use(
      (response) => {
        logRequest(response.config, "success", response.status)
        return response
      },
      async (error) => {
        const originalRequest = error.config
        logRequest(originalRequest, "error", error.response?.status, error.code)
        if (error.response?.status === 429)
          this.apiRetryAt = Date.now() + shiprocketRetryDelay(error)
        if (
          error.response?.status === 401 &&
          originalRequest?._retry &&
          !originalRequest.url?.includes("/auth/login")
        ) {
          this.cachedToken = null
          delete this.axios.defaults.headers.common["Authorization"]
          this.authRetryAt = Date.now() + 60000
        }
        if (
          originalRequest &&
          error.response?.status === 401 &&
          !originalRequest._retry &&
          !originalRequest.url?.includes("/auth/login")
        ) {
          originalRequest._retry = true
          try {
            const sentToken =
              originalRequest.headers?.get?.("Authorization") ??
              originalRequest.headers?.Authorization
            if (
              !this.cachedToken ||
              !this.isTokenValid() ||
              !sentToken ||
              sentToken === `Bearer ${this.cachedToken.token}`
            ) {
              this.cachedToken = null
              delete this.axios.defaults.headers.common["Authorization"]
              await this.refreshToken()
            }
            originalRequest.headers["Authorization"] =
              `Bearer ${this.cachedToken!.token}`
            return this.axios(originalRequest)
          } catch (refreshError) {
            return Promise.reject(refreshError)
          }
        }
        return Promise.reject(error)
      }
    )

    this.logger.info("ShiprocketClientManager initialized with HTTP keep-alive")
  }

  /**
   * Get the shared axios instance with valid authentication.
   * Automatically refreshes token if expired or about to expire.
   */
  async getAxios(): Promise<AxiosInstance> {
    await this.ensureToken()
    return this.axios
  }

  /**
   * Get the current token (for debugging/logging).
   */
  getTokenExpiry(): Date | null {
    return this.cachedToken ? new Date(this.cachedToken.expiresAt) : null
  }

  /**
   * Get delivery preference from environment (FAST or CHEAP).
   */
  getDeliveryPreference(): DeliveryPreference {
    return this.deliveryPreference
  }

  /**
   * Force a token refresh (e.g., for scheduled job).
   */
  async forceRefreshToken(): Promise<void> {
    await this.refreshToken()
    this.logger.info("Shiprocket token force-refreshed")
  }

  /**
   * Check if token is valid and not about to expire.
   */
  isTokenValid(): boolean {
    if (!this.cachedToken) return false
    // Add 1 minute buffer for safety
    return Date.now() < this.cachedToken.expiresAt - 60000
  }

  /**
   * Ensure we have a valid token, refreshing if needed.
   * Uses mutex pattern to prevent concurrent refresh requests.
   */
  private async ensureToken(): Promise<void> {
    if (this.isTokenValid()) {
      return
    }

    // If another refresh is in progress, wait for it
    if (this.tokenRefreshPromise) {
      await this.tokenRefreshPromise
      return
    }

    await this.refreshToken()
  }

  /**
   * Refresh the authentication token.
   * Thread-safe - prevents concurrent refresh requests.
   */
  private async refreshToken(): Promise<void> {
    if (Date.now() < this.authRetryAt)
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "Shiprocket authentication retry is delayed after a previous failure"
      )
    // Mutex pattern: only one refresh at a time
    if (this.tokenRefreshPromise) {
      await this.tokenRefreshPromise
      return
    }

    this.tokenRefreshPromise = this.doRefreshToken()

    try {
      await this.tokenRefreshPromise
    } finally {
      this.tokenRefreshPromise = null
    }
  }

  private async doRefreshToken(): Promise<void> {
    this.logger.debug("Refreshing Shiprocket token...")

    try {
      const response = await this.axios.post<{ token: string }>(
        "/auth/login",
        {
          email: this.email,
          password: this.password,
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: undefined,
            Accept: undefined,
          },
        }
      )

      if (!response.data?.token) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Shiprocket authentication failed: no token received"
        )
      }

      // Token valid for 10 days, refresh at 8 days
      this.cachedToken = {
        token: response.data.token,
        expiresAt: Date.now() + TOKEN_REFRESH_BUFFER_DAYS * 24 * 60 * 60 * 1000,
      }

      this.authFailures = 0
      this.authRetryAt = 0
      this.axios.defaults.headers.common["Authorization"] =
        `Bearer ${this.cachedToken.token}`

      this.logger.info(
        `Shiprocket token refreshed, expires at ${new Date(this.cachedToken.expiresAt).toISOString()}`
      )
    } catch (error: any) {
      this.authFailures++
      this.authRetryAt =
        Date.now() + shiprocketRetryDelay(error, this.authFailures)
      this.logger.error(`Shiprocket authentication failed: ${error.message}`)

      if (error instanceof MedusaError) throw error

      const apiError = error?.response?.data
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        apiError?.message || "Shiprocket authentication failed"
      )
    }
  }

  // ============================================
  // API Methods - Use these instead of creating clients
  // ============================================

  /**
   * Get pickup locations from Shiprocket.
   */
  async getPickupLocations(locationName?: string): Promise<any[]> {
    await this.ensureToken()

    try {
      const response = await this.axios.get<{
        data: { shipping_address: any[] }
      }>("/settings/company/pickup")

      const locations = response.data.data.shipping_address || []

      if (locationName) {
        return locations.filter(
          (loc: any) =>
            loc.pickup_location.toLowerCase() === locationName.toLowerCase()
        )
      }

      return locations
    } catch (error: any) {
      this.logger.error(`Failed to get pickup locations: ${error.message}`)
      return []
    }
  }

  /**
   * Get pincode for a pickup location by name.
   */
  async getPickupPincode(locationName: string): Promise<string | null> {
    const locations = await this.getPickupLocations(locationName)
    return locations[0]?.pin_code || null
  }

  /**
   * Get delivery estimate for a route.
   * Returns only the preferred courier using the configured courier policy.
   * Cached for 4 hours.
   */
  async getDeliveryEstimate(data: {
    pickup_postcode: string
    delivery_postcode: string
    weight?: number
    cod?: number
  }): Promise<{
    serviceable: boolean
    preference: DeliveryPreference
    courier_name: string | null
    courier_company_id: number | null
    etd: string | null
    estimated_delivery_days: string | null
    rate: number | null
    is_surface: boolean | null
    courier_count: number
  }> {
    await this.ensureToken()

    const weight = data.weight || 0.5
    const cod = 0
    const cacheKey = `${data.pickup_postcode}-${data.delivery_postcode}-${weight}-${cod}`

    // LRU eviction: if cache is full, remove oldest entry
    if (this.deliveryEstimateCache.size >= this.maxCacheSize) {
      const firstKey = this.deliveryEstimateCache.keys().next().value
      if (firstKey) {
        this.deliveryEstimateCache.delete(firstKey)
      }
    }

    // Check cache
    const cached = this.deliveryEstimateCache.get(cacheKey)
    if (cached && Date.now() < cached.expiresAt) {
      return cached.response
    }

    try {
      const response = await this.axios.get("/courier/serviceability/", {
        params: {
          pickup_postcode: data.pickup_postcode,
          delivery_postcode: data.delivery_postcode,
          weight,
          cod,
        },
      })

      const couriers = response.data?.data?.available_courier_companies || []

      if (couriers.length === 0) {
        const result = {
          serviceable: false,
          preference: this.deliveryPreference,
          courier_name: null,
          courier_company_id: null,
          etd: null,
          estimated_delivery_days: null,
          rate: null,
          is_surface: null,
          courier_count: 0,
        }
        // Cache even negative results
        this.deliveryEstimateCache.set(cacheKey, {
          response: result,
          expiresAt:
            Date.now() + DELIVERY_ESTIMATE_CACHE_HOURS * 60 * 60 * 1000,
        })
        return result
      }

      const selected = selectCourier(couriers, this.courierPolicy)
      const selectedRow = couriers.find(
        (row: any) =>
          Number(row.courier_company_id) === selected.courier_company_id
      )
      const result = {
        serviceable: true,
        preference: this.deliveryPreference,
        courier_name: selected.courier_name,
        courier_company_id: selected.courier_company_id,
        etd: selected.estimated_delivery_date,
        estimated_delivery_days: selected.estimated_delivery_days,
        rate: selected.amount,
        is_surface:
          typeof selectedRow?.is_surface === "boolean"
            ? selectedRow.is_surface
            : null,
        courier_count: couriers.length,
        relaxed_preferences: selected.relaxed_preferences,
      }

      // Cache result
      this.deliveryEstimateCache.set(cacheKey, {
        response: result,
        expiresAt: Date.now() + DELIVERY_ESTIMATE_CACHE_HOURS * 60 * 60 * 1000,
      })

      return result
    } catch (error: any) {
      if (error instanceof MedusaError) throw error

      this.logger.error(`Failed to get delivery estimate: ${error.message}`)
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        error?.response?.data?.message || "Failed to get delivery estimate"
      )
    }
  }

  /**
   * Get preferred courier for order creation.
   * Returns the courier_company_id using the configured courier policy.
   */
  async getPreferredCourier(data: {
    pickup_postcode: string
    delivery_postcode: string
    weight?: number
    cod?: number
  }): Promise<number | null> {
    const estimate = await this.getDeliveryEstimate(data)
    return estimate.courier_company_id
  }
}

/**
 * Get the singleton ShiprocketClientManager instance.
 * Use this in API routes instead of creating new ShiprocketClient instances.
 *
 * @example
 * ```typescript
 * const manager = getShiprocketManager()
 * const axios = await manager.getAxios()
 * const response = await axios.get("/courier/serviceability/", { params: {...} })
 * ```
 */
export function getShiprocketManager(
  logger?: Logger,
  options: ShiprocketClientOptions = {}
): ShiprocketClientManager {
  return ShiprocketClientManager.getInstance(logger, options)
}

/**
 * Check if Shiprocket credentials are configured.
 */
export function hasShiprocketCredentials(): boolean {
  return ShiprocketClientManager.hasCredentials()
}

/**
 * Reset the client manager (for testing).
 */
export function resetShiprocketManager(): void {
  ShiprocketClientManager.reset()
}

export default ShiprocketClientManager
