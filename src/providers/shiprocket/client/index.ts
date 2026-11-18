import {
  checkDocument,
  type DocumentCheck,
} from "../../../shared/document-download"
import {
  assignmentSecret,
  sealAssignment,
  openAssignment,
  DeferredAwbError,
} from "../../../shared/deferred-awb"
import { pickupScope } from "../../../shared/pickup-mapping"
import { shiprocketApiUrl } from "./config"
import { SHIPROCKET_DEFAULT_TIMEOUT_MS } from "./config"
import { awbErrorDiagnostic, awbErrorSummary } from "../../../shared/awb-error"
import { cancelFailedAwbOrder } from "../../../shared/failed-awb"
import { createHash } from "node:crypto"
import { indiaStateName } from "../../../shared/india-state"
import {
  recoverFulfillmentAttempt,
  retryReference,
} from "../../../shared/fulfillment-recovery"
import {
  validateExistingBinding,
  reviewExistingOrder,
  requireExistingOrderReview,
  type ExistingOrderBinding,
} from "../../../shared/existing-order"
import {
  financialSnapshot,
  shiprocketOrderMoney,
  stableFulfillmentReference,
  type FulfillmentFinancials,
} from "../../../shared/order-money"
import { pickupRows } from "../../../shared/pickup-mapping"
import type { ShippingMeasurements } from "../utils/quote"
import axios from "axios"
import type { AxiosInstance } from "axios"
import { MedusaError } from "@medusajs/framework/utils"
import { authenticate } from "./methods/authenticate"
import { handleError } from "./handle-error"
import { getShiprocketManager } from "./manager"
import {
  validateAndSanitizePhone,
  validateAndSanitizePincode,
  requireField,
} from "../utils/validation"
import { getLineItemDimensions } from "../utils/dimensions"
import {
  shiprocketQuote,
  shiprocketParcelDimensions,
  shiprocketDimensionCm,
} from "../utils/quote"
import {
  CourierQuoteError,
  courierPolicy,
  courierChoices,
  courierDecisionRows,
  selectCourier,
  assertMatchingCourier,
  type CourierPolicy,
  type CourierQuote,
} from "../utils/courier-policy"
import type { PickupSnapshot } from "../../../shared/pickup-mapping"
import type { Logger } from "@medusajs/framework/types"

import type {
  ShiprocketClientOptions,
  ShiprocketCalculateRateRequest,
  ShiprocketCalculateRateResponse,
  ShiprocketCreateOrderResponse,
  ShiprocketTrackingResponse,
  ShiprocketDeliveryEstimateRequest,
  ShiprocketDeliveryEstimateResponse,
  ShiprocketPickupLocation,
  ShiprocketPickupLocationsResponse,
} from "./types"

export default class ShiprocketClient {
  private diagnostics?: boolean
  private policy: CourierPolicy
  private requestTimeout: number
  private verifyDocuments: boolean
  private autoAssignAwb: boolean
  private assignmentKey?: string
  private accountScope: string
  private email: string
  private password: string
  private axios: AxiosInstance
  private token: string | null = null
  private isDisposed = false
  private logger?: Logger
  private manager: ReturnType<typeof getShiprocketManager>

  constructor(options: ShiprocketClientOptions) {
    if (!options.email || !options.password) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Shiprocket API credentials are required"
      )
    }

    this.diagnostics = options.rate_diagnostics
    this.CACHE_TTL = options.rate_cache_ttl_ms ?? 300000
    this.requestTimeout = options.timeout ?? SHIPROCKET_DEFAULT_TIMEOUT_MS
    this.verifyDocuments = options.verify_documents ?? false
    this.autoAssignAwb = options.auto_assign_awb ?? true
    if (typeof this.autoAssignAwb !== "boolean")
      throw Error("auto_assign_awb must be boolean")
    this.assignmentKey = !this.autoAssignAwb
      ? assignmentSecret(options.assignment_secret)
      : options.assignment_secret
    this.accountScope = pickupScope(
      shiprocketApiUrl(options.mode),
      options.email || ""
    )
    this.policy = courierPolicy(options)
    this.email = options.email || ""
    this.password = options.password || ""
    this.logger = options.logger
    this.manager = getShiprocketManager(options.logger, options)
    // We do not instantiate a new `axios` here. We will use the shared one from `manager.ts`
    // We keep this structure compatible with existing code but route requests through the manager.
  }

  dispose(): void {
    this.isDisposed = true
    // If we were holding onto anything else, we'd dispose it here
  }

  private async getSharedAxios(): Promise<AxiosInstance> {
    if (this.isDisposed) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "ShiprocketClient is disposed"
      )
    }
    const manager = this.manager
    return await manager.getAxios()
  }

  /**
   * Get all pickup locations with their pincodes
   * @param locationName Optional - filter by location name/nickname
   */
  async getPickupLocations(
    locationName?: string
  ): Promise<ShiprocketPickupLocation[]> {
    try {
      const response = await (
        await this.getSharedAxios()
      ).get<ShiprocketPickupLocationsResponse>("/settings/company/pickup")

      const locations = response.data.data.shipping_address || []

      // Filter by location name if provided
      if (locationName) {
        return locations.filter(
          (loc) =>
            loc.pickup_location.toLowerCase() === locationName.toLowerCase()
        )
      }

      return locations
    } catch (error: any) {
      handleError(error, { operation: "getPickupLocations" })
      return []
    }
  }

  /**
   * Get pincode for a pickup location by name
   */
  async getPickupPincode(locationName: string): Promise<string | null> {
    const locations = await this.getPickupLocations(locationName)
    return locations[0]?.pin_code || null
  }

  private rateCache = new Map<string, { rows: any[]; timestamp: number }>()
  private rateRequests = new Map<string, Promise<any[]>>()
  private CACHE_TTL = 5 * 60 * 1000
  async calculate(data: ShiprocketCalculateRateRequest): Promise<number> {
    return (await this.quote(data)).amount
  }
  private async courierRows(
    data: ShiprocketCalculateRateRequest,
    fresh = false
  ): Promise<any[]> {
    const { allowed_courier_ids, ...request } = { ...data, cod: 0 }
    const key = JSON.stringify(request)
    const cached = this.rateCache.get(key)
    if (!fresh && cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      this.logRateInput(data, "cache_hit")
      return cached.rows
    }
    const pending = this.rateRequests.get(key)
    if (pending) {
      this.logRateInput(data, "shared_inflight_request")
      return pending
    }
    this.logRateInput(data, fresh ? "fresh_api_request" : "api_request")
    const operation = (async () => {
      const response = await (
        await this.getSharedAxios()
      ).get<ShiprocketCalculateRateResponse>("/courier/serviceability/", {
        params: request,
      })
      const rows = response.data?.data?.available_courier_companies
      if (!Array.isArray(rows))
        throw new CourierQuoteError(
          "Shiprocket returned an invalid courier list"
        )
      if (this.rateCache.size >= 1000)
        this.rateCache.delete(this.rateCache.keys().next().value!)
      this.rateCache.set(key, { rows, timestamp: Date.now() })
      return rows
    })()
    this.rateRequests.set(key, operation)
    try {
      return await operation
    } finally {
      this.rateRequests.delete(key)
    }
  }
  /** Read-only guard before a merchant changes the intended courier. */
  async existingFulfillmentAttempts(nativeOrderId: string, reference: string) {
    const api = await this.getSharedAxios()
    const result: {
      order_id: number
      shipment_id: number
      awb_present: boolean
    }[] = []
    for (let page = 1; page <= 20; page++) {
      const response = await api.get("/orders", {
        params: { page, per_page: 100 },
      })
      const rows = response.data?.data
      if (!Array.isArray(rows))
        throw new CourierQuoteError(
          "Existing shipments could not be checked. Try again before changing courier."
        )
      for (const row of rows) {
        const ref = String(row.channel_order_id || "")
        if (
          ref !== reference &&
          !(
            ref.startsWith(nativeOrderId + "-") &&
            /^\d{10}$/.test(ref.slice(nativeOrderId.length + 1))
          )
        )
          continue
        const detail = await api.get(`/orders/show/${Number(row.id)}`)
        const order = detail.data?.data ?? detail.data
        const shipments = Array.isArray(order.shipments)
          ? order.shipments
          : order.shipments
            ? [order.shipments]
            : []
        for (const shipment of shipments)
          result.push({
            order_id: Number(order.id),
            shipment_id: Number(shipment.id),
            awb_present: !!String(
              shipment.awb || shipment.awb_code || ""
            ).trim(),
          })
      }
      const pages = Number(response.data?.meta?.pagination?.total_pages)
      if (
        (Number.isSafeInteger(pages) && pages > 0 && page >= pages) ||
        (!Number.isSafeInteger(pages) && rows.length < 100) ||
        (pages === 0 && rows.length === 0)
      )
        return result
    }
    throw new CourierQuoteError(
      "Existing shipments could not be fully checked. Review them before changing courier."
    )
  }

  /** All eligible merchant alternatives in the originally purchased service mode. */
  async fulfillmentCouriers(
    data: ShiprocketCalculateRateRequest,
    service: "air" | "surface"
  ) {
    const rows = await this.courierRows(data, true)
    const result: CourierQuote[] = []
    for (const id of new Set(
      rows.map((row) => Number(row.courier_company_id))
    )) {
      try {
        const quote = selectCourier(
          rows,
          this.policy,
          data.allowed_courier_ids,
          id
        )
        if (quote.service === service) result.push(quote)
      } catch (error) {
        if (!(error instanceof CourierQuoteError)) throw error
      }
    }
    return result.sort(
      (a, b) =>
        a.amount - b.amount || a.courier_company_id - b.courier_company_id
    )
  }
  async quotes(data: ShiprocketCalculateRateRequest): Promise<CourierQuote[]> {
    const rows = await this.courierRows(data)
    return this.selectRates(rows, data)
  }
  private logRateInput(data: ShiprocketCalculateRateRequest, source: string) {
    if (!(this.diagnostics ?? true)) return
    this.logger?.info(
      "Shiprocket rate input " +
        JSON.stringify({
          route_id: this.rateRouteId(data),
          source,
          prepaid: true,
          weight_kg: data.weight,
          length_cm: data.length ?? null,
          breadth_cm: data.breadth ?? null,
          height_cm: data.height ?? null,
          policy: this.policy,
          allowed_courier_ids: data.allowed_courier_ids ?? [],
          cache_ttl_ms: this.CACHE_TTL,
        })
    )
  }
  private rateRouteId(data: ShiprocketCalculateRateRequest) {
    // Correlate the lane/parcel without logging customer postcodes or addresses.
    return createHash("sha256")
      .update(
        JSON.stringify([
          data.pickup_postcode,
          data.delivery_postcode,
          data.weight,
          data.length ?? null,
          data.breadth ?? null,
          data.height ?? null,
        ])
      )
      .digest("hex")
      .slice(0, 16)
  }
  private selectRates(
    rows: any[],
    data: ShiprocketCalculateRateRequest,
    selectedId?: number,
    single = false
  ): CourierQuote[] {
    let choices: CourierQuote[] = []
    try {
      choices = !single
        ? courierChoices(rows, this.policy, data.allowed_courier_ids)
        : [
            selectCourier(
              rows,
              this.policy,
              data.allowed_courier_ids,
              selectedId
            ),
          ]
      return choices
    } finally {
      if (this.diagnostics ?? true)
        this.logger?.info(
          "Shiprocket rate decision " +
            JSON.stringify({
              route_id: this.rateRouteId(data),
              policy: this.policy,
              selection: !single
                ? "best_per_service"
                : selectedId === undefined
                  ? "best_overall"
                  : "revalidate_selected_courier",
              requested_courier_id: selectedId ?? null,
              ranking:
                this.policy.selection === "highest_rating"
                  ? ["rating_desc", "amount_asc", "courier_id_asc"]
                  : ["amount_asc", "courier_id_asc"],
              preference_relaxation_order: [
                "call_before_delivery",
                "pod",
                "real_time_tracking",
              ],
              outcome: choices.length ? "selected" : "no_eligible_courier",
              candidates: courierDecisionRows(
                rows,
                this.policy,
                data.allowed_courier_ids,
                choices,
                !single
              ),
            })
        )
    }
  }

  async quote(
    data: ShiprocketCalculateRateRequest,
    expected?: unknown,
    fresh = false,
    validate?: (quote: CourierQuote) => void
  ): Promise<CourierQuote> {
    const selectedId =
      expected == null
        ? undefined
        : Number((expected as any).courier_company_id)
    if (
      selectedId !== undefined &&
      (!Number.isSafeInteger(selectedId) || selectedId <= 0)
    )
      throw new CourierQuoteError(
        "Invalid selected Shiprocket courier; select shipping again"
      )
    const [quote] = this.selectRates(
      await this.courierRows(data, fresh),
      data,
      selectedId,
      true
    )
    if (validate && expected && typeof expected === "object") {
      // Identity/category are always enforced; merchant policy only controls cost acceptance.
      assertMatchingCourier({ ...expected, amount: quote.amount }, quote)
      try {
        validate(quote)
      } catch (error: any) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          error?.message ||
            "The merchant shipping-cost policy rejected this quote"
        )
      }
    } else assertMatchingCourier(expected, quote)
    if (quote.relaxed_preferences.length)
      this.logger?.warn(
        "Shiprocket courier preferences relaxed: " +
          quote.relaxed_preferences.join(", ") +
          "; selected courier " +
          quote.courier_company_id
      )
    return quote
  }

  /**
   * Get delivery estimate for a route - returns raw Shiprocket API response
   */
  async getDeliveryEstimate(
    data: ShiprocketDeliveryEstimateRequest
  ): Promise<any> {
    try {
      const response = await (
        await this.getSharedAxios()
      ).get("/courier/serviceability/", {
        params: {
          pickup_postcode: data.pickup_postcode,
          delivery_postcode: data.delivery_postcode,
          weight: data.weight || 0.5,
          cod: 0,
        },
      })

      return response.data
    } catch (error: any) {
      if (error instanceof MedusaError) throw error
      if (error?.response?.status === 404) {
        return {
          status: 404,
          data: { available_courier_companies: [] },
        }
      }
      handleError(error, { operation: "getDeliveryEstimate" })
    }
  }

  /**
   * Create an order in Shiprocket and assign AWB
   */
  async prepareFulfillment(
    fulfillment: any,
    items: any[],
    order: any,
    pickup: PickupSnapshot,
    checkoutQuote?: unknown,
    measuredParcel?: unknown,
    itemMeasurements?: Record<string, ShippingMeasurements>,
    validateRate?: (quote: CourierQuote) => void,
    financials?: FulfillmentFinancials
  ) {
    // Map order items by ID for quick lookup
    const orderItemMap = new Map()
    if (Array.isArray(order.items)) {
      order.items.forEach((orderItem: any) => {
        orderItemMap.set(orderItem.id, orderItem)
      })
    }

    let totalUnits = 0
    let totalWeight = 0
    let totalLength = 0
    let totalBreadth = 0
    let totalHeight = 0

    // Email lives on the customer object in FulfillmentOrderDTO — not at the order level
    const customerEmail = order?.customer?.email

    // strict YYYY-MM-DD HH:mm for shiprocket
    const d = new Date(order.created_at)
    const pad = (n: number) => n.toString().padStart(2, "0")
    const orderDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`

    // Physical units come from commercial order quantities, not inventory BOM components.
    const commercial =
      financials?.selected_items ||
      items.map((item: any) => ({
        id: item.line_item_id,
        quantity: Number(item.quantity),
      }))
    for (const item of commercial) {
      const orderItem = orderItemMap.get(item.id)
      if (!orderItem)
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Order item missing from package"
        )
      const m = getLineItemDimensions(
        orderItem.variant,
        itemMeasurements?.[item.id]
      )
      if (
        !measuredParcel &&
        ![m.weightKg, m.length, m.width, m.height].every(
          (v) => Number.isFinite(v) && v > 0
        )
      )
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Complete native packed weight and dimensions before shipping"
        )
      totalUnits += Number(item.quantity)
      totalWeight = m.weightKg
      totalLength = m.length
      totalBreadth = m.width
      totalHeight = m.height
    }

    const shipping =
      order.shipping_address || fulfillment?.delivery_address || {}
    // billing_address is not included in FulfillmentOrderDTO — fall back to shipping
    const billing =
      order.billing_address && Object.keys(order.billing_address).length > 0
        ? order.billing_address
        : shipping
    const shippingIsBilling =
      !order.billing_address ||
      (shipping.address_1 === billing.address_1 &&
        shipping.postal_code === billing.postal_code)

    if (totalUnits > 1 && !measuredParcel)
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Fulfill one packed unit at a time."
      )
    const packed = measuredParcel
      ? shiprocketQuote({
          currency_code: "inr",
          from_location: {
            address: { country_code: "in", postal_code: pickup.postcode },
          },
          shipping_address: shipping,
          shiprocket_parcel: measuredParcel,
        })
      : {
          weight: totalWeight,
          ...shiprocketParcelDimensions(totalLength, totalBreadth, totalHeight),
        }
    // The stored remote ID establishes identity. The order API still uses
    // its current verified nickname; do not assume ID-only order support.
    const pickupResponse = await (
      await this.getSharedAxios()
    ).get("/settings/company/pickup", { params: { id: pickup.external_id } })
    const boundPickup = pickupRows(pickupResponse.data).find(
      (row) => String(row.id) === String(pickup.external_id)
    )
    const pickupNickname =
      boundPickup?.pickup_location || boundPickup?.pickup_code
    if (!pickupNickname)
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "The mapped Shiprocket pickup ID is missing; review the warehouse mapping"
      )
    if (String(boundPickup.pin_code).trim() !== String(pickup.postcode))
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "The mapped Shiprocket pickup postcode changed; review the pickup link before fulfilling"
      )
    const financialContext =
      financials ||
      financialSnapshot(
        order,
        order.shipping_methods?.find(
          (method: any) =>
            method.shipping_option_id === fulfillment.shipping_option_id
        ) || order.shipping_methods?.[0],
        items.map((item) => ({
          id: item.line_item_id,
          quantity: Number(item.quantity ?? item.raw_quantity?.value),
        }))
      )
    const money = shiprocketOrderMoney(financialContext)
    const moneyItems = money.items.map((line) => {
      const orderItem = orderItemMap.get(line.line_item_id)
      if (!orderItem)
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Financial order item is missing"
        )
      const { line_item_id, ...amounts } = line
      return {
        name:
          orderItem.title ||
          items.find((item) => item.line_item_id === line_item_id)?.title,
        sku: orderItem.variant?.sku || orderItem.variant_sku || orderItem.id,
        ...amounts,
        hsn: Number(orderItem.variant?.hs_code || 0),
      }
    })
    // Build order payload
    const merchantReference = stableFulfillmentReference(
      order.id,
      fulfillment.shipping_option_id || "",
      financialContext
    )
    const orderData = {
      order_id: merchantReference,
      order_date: orderDate,
      pickup_location: pickupNickname,

      billing_customer_name: requireField(
        billing.first_name || shipping.first_name,
        "Billing First Name"
      ),
      billing_last_name: billing.last_name || shipping.last_name || "",
      billing_address: requireField(
        billing.address_1 || shipping.address_1,
        "Billing Address"
      ),
      billing_address_2: billing.address_2 || shipping.address_2 || "",
      billing_city: requireField(billing.city || shipping.city, "Billing City"),
      billing_pincode: validateAndSanitizePincode(
        requireField(
          billing.postal_code || shipping.postal_code,
          "Billing Pincode"
        ),
        "Billing Pincode"
      ),
      billing_state: requireField(
        indiaStateName(billing.province || shipping.province),
        "Billing State"
      ),
      billing_country: requireField(
        billing.country_code || shipping.country_code || "IN",
        "Billing Country"
      ),
      billing_email: requireField(customerEmail, "Billing Email"),
      billing_phone: validateAndSanitizePhone(
        requireField(billing.phone || shipping.phone, "Billing Phone"),
        "Billing Phone"
      ),

      shipping_is_billing: shippingIsBilling,
      shipping_customer_name: requireField(
        shipping.first_name,
        "Shipping First Name"
      ),
      shipping_last_name: shipping.last_name || "",
      shipping_address: requireField(shipping.address_1, "Shipping Address"),
      shipping_address_2: shipping.address_2 || "",
      shipping_city: requireField(shipping.city, "Shipping City"),
      shipping_pincode: validateAndSanitizePincode(
        requireField(shipping.postal_code, "Shipping Pincode"),
        "Shipping Pincode"
      ),
      shipping_country: requireField(
        shipping.country_code || "IN",
        "Shipping Country"
      ),
      shipping_state: requireField(
        indiaStateName(shipping.province),
        "Shipping State"
      ),
      shipping_email: requireField(customerEmail, "Shipping Email"),
      shipping_phone: validateAndSanitizePhone(
        requireField(shipping.phone, "Shipping Phone"),
        "Shipping Phone"
      ),

      order_items: moneyItems,
      payment_method: "Prepaid",
      sub_total: money.sub_total,
      total_discount: money.total_discount,
      shipping_charges: money.shipping_charges,
      giftwrap_charges: money.giftwrap_charges,
      transaction_charges: money.transaction_charges,
      length: packed.length,
      breadth: packed.breadth,
      height: packed.height,
      weight: packed.weight,
    }

    if (!checkoutQuote)
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Shiprocket checkout courier quote is required; select shipping again"
      )
    const selectedQuote = await this.quote(
      {
        pickup_postcode: pickup.postcode,
        delivery_postcode: String(shipping.postal_code),
        weight: orderData.weight,
        length: orderData.length,
        breadth: orderData.breadth,
        height: orderData.height,
        cod: 0,
      },
      checkoutQuote,
      true,
      validateRate
    )
    return { orderData, selectedQuote, money }
  }

  private async existingRemote(
    binding: ExistingOrderBinding,
    timeout?: number
  ) {
    validateExistingBinding(binding)
    const deadline = timeout ? Date.now() + timeout : undefined
    const readOptions = () => {
      if (!deadline) return undefined
      const remaining = deadline - Date.now()
      if (remaining <= 0)
        throw new Error("Shiprocket recovery read budget exhausted")
      return { timeout: remaining }
    }
    const api = await this.getSharedAxios(),
      response = await api.get(
        `/orders/show/${binding.order_id}`,
        readOptions()
      )
    const remote = response.data?.data ?? response.data
    let detail: any
    if (
      /[xX*]/.test(String(remote?.customer_phone ?? "")) ||
      !String(remote?.customer_phone ?? "").replace(/\D/g, "")
    ) {
      const shipment = await api.get(
        `/shipments/${binding.shipment_id}`,
        readOptions()
      )
      detail = shipment.data?.data ?? shipment.data
    }
    return { body: response.data, detail }
  }

  async reviewExistingFulfillment(
    binding: ExistingOrderBinding,
    ...args: Parameters<ShiprocketClient["prepareFulfillment"]>
  ) {
    validateExistingBinding(binding)
    const prepared = await this.prepareFulfillment(...args)
    const response = await this.existingRemote(binding)
    return reviewExistingOrder(
      response.body,
      prepared.orderData,
      args[3].external_id,
      binding,
      args[2].id,
      prepared.selectedQuote.courier_company_id,
      response.detail
    )
  }

  /** Read-only cancellation inspection. Never revalidates rates or cancels an active shipment. */
  async inspectCancelledFulfillment(
    args: Parameters<ShiprocketClient["prepareFulfillment"]>,
    protectedOrderIds: number[],
    referenceHint: string
  ) {
    const financials = args[8]
    if (!financials)
      throw new CourierQuoteError(
        "The saved native financial allocation is required to verify shipment cancellation"
      )
    return recoverFulfillmentAttempt(await this.getSharedAxios(), {
      native_order_id: args[2].id,
      order_data: {
        order_id: stableFulfillmentReference(
          args[2].id,
          args[0].shipping_option_id || "",
          financials
        ),
      },
      pickup_id: args[3].external_id,
      courier_id: 0,
      protected_order_ids: protectedOrderIds,
      reference_hint: referenceHint,
      allow_cancel: false,
    })
  }

  async recoverFailedFulfillment(
    args: Parameters<ShiprocketClient["prepareFulfillment"]>,
    protectedOrderIds: number[],
    beforeWrite?: () => void,
    history?: { reference_hint?: string; no_previous_attempt?: boolean }
  ) {
    const prepared = await this.prepareFulfillment(...args)
    return recoverFulfillmentAttempt(
      await this.getSharedAxios(),
      {
        native_order_id: args[2].id,
        order_data: prepared.orderData,
        pickup_id: args[3].external_id,
        courier_id: prepared.selectedQuote.courier_company_id,
        protected_order_ids: protectedOrderIds,
        allow_unassigned_resume: !this.autoAssignAwb,
        ...history,
      },
      beforeWrite
    )
  }

  async create(
    fulfillment: any,
    items: any[],
    order: any,
    pickup: PickupSnapshot,
    checkoutQuote?: unknown,
    measuredParcel?: unknown,
    itemMeasurements?: Record<string, ShippingMeasurements>,
    validateRate?: (quote: CourierQuote) => void,
    beforeCreate?: () => void,
    financials?: FulfillmentFinancials,
    resume?: ExistingOrderBinding,
    recoveryReference?: string
  ): Promise<ShiprocketCreateOrderResponse> {
    if (
      !this.autoAssignAwb &&
      (typeof fulfillment?.id !== "string" ||
        !fulfillment.id ||
        fulfillment.id.length > 128)
    )
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "A native fulfillment ID is required before creating a manual AWB draft"
      )
    let creationRequested = false
    let failedAwbInput: Parameters<typeof cancelFailedAwbOrder>[1] | undefined
    let awbRequested = false
    let awbPresent = false
    let awbRecoveryAttempted = false
    let awbRecovered = false
    let awbRejectionConfirmed = false
    let awbDiagnostic: ReturnType<typeof awbErrorDiagnostic> | undefined
    const sensitiveValues: unknown[] = [this.email, this.password, this.token]
    let merchantReference = resume?.merchant_reference || ""
    try {
      const { orderData, selectedQuote, money } = await this.prepareFulfillment(
        fulfillment,
        items,
        order,
        pickup,
        checkoutQuote,
        measuredParcel,
        itemMeasurements,
        validateRate,
        financials
      )
      for (const [key, value] of Object.entries(orderData)) {
        if (
          /^(billing|shipping)_(customer_name|last_name|address(?:_[12])?|email|phone|alternate_phone)$/.test(
            key
          )
        )
          sensitiveValues.push(value)
      }
      if (recoveryReference) {
        const base = orderData.order_id
        const suffix = recoveryReference.slice(
          (base.slice(0, 40) + "_r").length
        )
        if (
          recoveryReference !== base &&
          recoveryReference !== resume?.merchant_reference &&
          (!/^[1-9][0-9]{0,7}$/.test(suffix) ||
            recoveryReference !== retryReference(base, Number(suffix)))
        )
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            "Shipment retry reference does not belong to this fulfillment"
          )
        orderData.order_id = recoveryReference
      }
      merchantReference ||= orderData.order_id
      let existingReview: ReturnType<typeof reviewExistingOrder> | undefined
      if (resume) {
        validateExistingBinding(resume)
        const response = await this.existingRemote(resume)
        existingReview = reviewExistingOrder(
          response.body,
          orderData,
          pickup.external_id,
          resume,
          order.id,
          selectedQuote.courier_company_id,
          response.detail
        )
        requireExistingOrderReview(existingReview, resume.review_digest)
      }
      // Carrier writes happen only after the chosen courier is revalidated.
      beforeCreate?.()
      creationRequested = true
      const orderCreated = resume
        ? {
            data: {
              order_id: resume.order_id,
              shipment_id: resume.shipment_id,
            } as ShiprocketCreateOrderResponse,
          }
        : await (
            await this.getSharedAxios()
          )
            .post<ShiprocketCreateOrderResponse>(
              "/orders/create/adhoc",
              orderData,
              { shiprocket_order_id: order.id } as any
            )
            .catch((err) => {
              const apiError = err?.response?.data?.errors
              if (apiError) {
                const firstError = Object.values(apiError)[0]
                const msg = Array.isArray(firstError)
                  ? firstError[0]
                  : firstError
                throw new MedusaError(
                  MedusaError.Types.INVALID_DATA,
                  `Shiprocket: ${msg}`
                )
              }
              throw err
            })

      if (!orderCreated.data?.shipment_id) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Shiprocket order created but no shipment ID returned"
        )
      }

      // Courier was revalidated before order creation. Never auto-assign
      // a different carrier from the one selected during checkout.
      const awbPayload = {
        shipment_id: orderCreated.data.shipment_id,
        courier_id: selectedQuote.courier_company_id,
      }
      if (
        !resume &&
        Number.isSafeInteger(Number(orderCreated.data.order_id)) &&
        Number(orderCreated.data.order_id) > 0 &&
        Number.isSafeInteger(Number(orderCreated.data.shipment_id)) &&
        Number(orderCreated.data.shipment_id) > 0
      ) {
        failedAwbInput = {
          binding: {
            order_id: Number(orderCreated.data.order_id),
            shipment_id: Number(orderCreated.data.shipment_id),
            merchant_reference: merchantReference,
          },
          order_data: orderData,
          native_order_id: order.id,
          pickup_id: pickup.external_id,
          courier_id: selectedQuote.courier_company_id,
        }
      }
      if (!this.autoAssignAwb && !existingReview?.awb) {
        const binding = failedAwbInput?.binding ?? resume
        if (!binding)
          throw new Error("Shiprocket draft identity could not be verified")
        return {
          ...orderCreated.data,
          shiprocket_merchant_reference: merchantReference,
          shiprocket_financials: money.summary,
          shiprocket_awb_state: "pending",
          ...(resume
            ? {
                shiprocket_reconciled_existing: true,
                shiprocket_native_order_id: order.id,
                shiprocket_native_selection: money.items.map((line) => ({
                  id: line.line_item_id,
                  quantity: line.units,
                })),
                shiprocket_reconciliation_digest: resume.review_digest,
                shiprocket_resume_transaction_id:
                  resume.workflow_transaction_id,
                shiprocket_reconciliation_warnings:
                  existingReview?.warnings || [],
              }
            : {}),
          shiprocket_deferred_awb: sealAssignment(
            {
              binding,
              order_data: orderData,
              pickup_id: pickup.external_id,
              native_order_id: order.id,
              scope: this.accountScope,
              quote: selectedQuote,
              quote_request: {
                pickup_postcode: pickup.postcode,
                delivery_postcode: String(orderData.shipping_pincode),
                weight: orderData.weight,
                length: orderData.length,
                breadth: orderData.breadth,
                height: orderData.height,
                cod: 0,
              },
            },
            String(fulfillment.id || ""),
            this.assignmentKey!
          ),
          courier_name: selectedQuote.courier_name,
          shiprocket_carrier_cost: {
            amount: selectedQuote.amount,
            currency_code: "inr",
            courier_company_id: selectedQuote.courier_company_id,
            service: selectedQuote.service,
          },
        }
      }
      awbRequested = !existingReview?.awb
      const awbCreated = existingReview?.awb
        ? {
            data: {
              awb_assign_status: 1,
              response: {
                data: {
                  awb_code: existingReview.awb,
                  courier_company_id: existingReview.courier_company_id,
                },
              },
            },
          }
        : await (
            await this.getSharedAxios()
          )
            .post("/courier/assign/awb", awbPayload, {
              timeout: this.requestTimeout,
              shiprocket_order_id: order.id,
            } as any)
            .catch(async (error: any) => {
              const uncertain =
                !error?.response ||
                [408, 500, 502, 503, 504].includes(error.response.status)
              const binding = failedAwbInput?.binding ?? resume
              if (!uncertain || !binding) throw error
              awbRecoveryAttempted = true
              // Never replay assignment. All reads share one configured timeout budget.
              const deadline = Date.now() + this.requestTimeout
              for (const delay of [0, 1000, 3000]) {
                if (Date.now() + delay >= deadline) break
                if (delay)
                  await new Promise((resolve) => setTimeout(resolve, delay))
                try {
                  const response = await this.existingRemote(
                    binding,
                    deadline - Date.now()
                  )
                  const review = reviewExistingOrder(
                    response.body,
                    orderData,
                    pickup.external_id,
                    binding,
                    order.id,
                    selectedQuote.courier_company_id,
                    response.detail
                  )
                  if (review.ready && review.awb) {
                    awbRecovered = true
                    this.logger?.info(
                      "Shiprocket AWB recovered after uncertain assignment " +
                        JSON.stringify({
                          order_id: order.id,
                          remote_order_id: binding.order_id,
                          shipment_id: binding.shipment_id,
                          http_status: error?.response?.status,
                        })
                    )
                    return {
                      data: {
                        awb_assign_status: 1,
                        response: {
                          data: {
                            awb_code: review.awb,
                            courier_company_id: review.courier_company_id,
                            courier_name: selectedQuote.courier_name,
                          },
                        },
                      },
                    }
                  }
                  // Stop on cancellation/pickup evidence. Other incomplete reads may settle,
                  // but an AWB is adopted only after every verification check passes.
                  if (
                    review.issues.some((issue) =>
                      [
                        "order_cancellation",
                        "shipment_cancellation",
                        "pickup_state",
                      ].includes(issue)
                    )
                  )
                    break
                } catch {
                  // A failed read leaves the result uncertain; the existing safe failure path retains it.
                }
              }
              throw error
            })

      const awbStatus = awbCreated.data?.awb_assign_status
      const responseBody = awbCreated.data?.response?.data
      awbPresent =
        typeof responseBody?.awb_code === "string" &&
        !!responseBody.awb_code.trim()
      awbDiagnostic = awbErrorDiagnostic(awbCreated.data, sensitiveValues)
      const detail = awbErrorSummary(awbDiagnostic)
      const rawReasons = [
        awbCreated.data?.message,
        awbCreated.data?.error,
        awbCreated.data?.response?.message,
        awbCreated.data?.response?.error,
        awbCreated.data?.response?.data,
        responseBody?.awb_assign_error,
        responseBody?.rmk,
        responseBody?.message,
        responseBody?.error,
      ]
        .filter((value) => typeof value === "string")
        .join(" ")
      const reason = /insufficient|wallet|balance/i.test(rawReasons)
        ? "balance"
        : /timeout|timed out|curl.*28/i.test(rawReasons)
          ? "upstream_timeout"
          : /kyc|verif/i.test(rawReasons)
            ? "verification"
            : /serviceab|courier.*avail|disabled.*courier/i.test(rawReasons)
              ? "courier_unavailable"
              : /invalid|validation/i.test(rawReasons)
                ? "validation"
                : "unclassified"
      const upstreamStatus = Number(awbDiagnostic.status_code)
      awbRejectionConfirmed =
        (awbStatus === 0 || awbStatus === "0") &&
        !awbPresent &&
        !/timeout|timed\s*out|gateway|curl.*28/i.test(
          rawReasons + " " + detail
        ) &&
        ![408, 425, 429].includes(upstreamStatus) &&
        !(upstreamStatus >= 500 && upstreamStatus <= 599)
      this.logger?.info(
        "Shiprocket AWB result " +
          JSON.stringify({
            order_id: order.id,
            remote_order_id: orderCreated.data.order_id,
            shipment_id: orderCreated.data.shipment_id,
            status:
              typeof awbStatus === "number" ||
              /^[0-9]+$/.test(String(awbStatus))
                ? awbStatus
                : null,
            status_type: typeof awbStatus,
            awb_present: !!responseBody?.awb_code,
            courier_id: Number(responseBody?.courier_company_id) || undefined,
            reason,
            error_detail: awbDiagnostic.message,
            action_required: awbDiagnostic.action_required,
            error_status_code: awbDiagnostic.status_code,
            assignment_error_present:
              typeof responseBody?.awb_assign_error === "string",
            keys: Object.keys(awbCreated.data || {}).filter((key) =>
              [
                "message",
                "error",
                "response",
                "data",
                "status",
                "status_code",
                "awb_assign_status",
              ].includes(key)
            ),
          })
      )
      if (awbStatus !== 1 && awbStatus !== "1") {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          `Shiprocket did not assign an AWB for existing order ${orderCreated.data.order_id}, shipment ${orderCreated.data.shipment_id} (${reason}).${detail ? ` Shiprocket reason: ${detail}.` : ""} The draft is retained for review; no replacement or pickup was created.`
        )
      }

      const responseData = awbCreated.data.response.data
      if (
        typeof responseData?.awb_code !== "string" ||
        !responseData.awb_code.trim()
      )
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          `Shiprocket reported AWB success without an AWB for order ${orderCreated.data.order_id}, shipment ${orderCreated.data.shipment_id}. Review that shipment before retrying.`
        )
      if (
        Number(responseData.courier_company_id) !==
        selectedQuote.courier_company_id
      )
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Shiprocket assigned a different courier than requested; review the remote shipment before retrying"
        )

      // Pickup scheduling is a separate merchant action; creating a fulfillment
      // must not dispatch a carrier automatically.

      return {
        ...orderCreated.data,
        shiprocket_financials: money.summary,
        shiprocket_merchant_reference: merchantReference,
        ...(awbRecovered ? { shiprocket_awb_recovered: true } : {}),
        ...(resume
          ? {
              shiprocket_reconciled_existing: true,
              shiprocket_reconciliation_warnings:
                existingReview?.warnings || [],
              shiprocket_resume_transaction_id: resume.workflow_transaction_id,
              shiprocket_native_selection: money.items.map((line) => ({
                id: line.line_item_id,
                quantity: line.units,
              })),
              shiprocket_native_order_id: order.id,
              shiprocket_reconciliation_digest: resume.review_digest,
            }
          : {}),
        shiprocket_carrier_cost: {
          amount: selectedQuote.amount,
          currency_code: "inr",
          courier_company_id: selectedQuote.courier_company_id,
          service: selectedQuote.service,
        },
        awb: responseData.awb_code,
        courier_company_id: responseData.courier_company_id,
        courier_name:
          responseData.courier_name || orderCreated.data.courier_name,
        tracking_number: responseData.awb_code,
        tracking_url: `https://shiprocket.co/tracking/${encodeURIComponent(responseData.awb_code)}`,
      }
    } catch (error: any) {
      if (awbRequested && !awbPresent) {
        awbDiagnostic ??= awbErrorDiagnostic(
          error?.response?.data,
          sensitiveValues
        )
        this.logger?.warn(
          "Shiprocket AWB failure " +
            JSON.stringify({
              order_id: order.id,
              remote_order_id:
                failedAwbInput?.binding.order_id ?? resume?.order_id,
              shipment_id:
                failedAwbInput?.binding.shipment_id ?? resume?.shipment_id,
              http_status: error?.response?.status,
              transport_code:
                typeof error?.code === "string" &&
                /^[A-Z0-9_]{1,40}$/.test(error.code)
                  ? error.code
                  : undefined,
              ...awbDiagnostic,
            })
        )
      }
      const detail = awbErrorSummary(awbDiagnostic || {})
      const diagnosticSuffix = detail ? ` Shiprocket reason: ${detail}.` : ""
      if (
        failedAwbInput &&
        awbRequested &&
        !awbPresent &&
        !awbRejectionConfirmed
      ) {
        const { binding } = failedAwbInput
        let verifiedAwb = ""
        try {
          if (awbRecoveryAttempted)
            throw Error("Bounded readback already exhausted")
          const response = await this.existingRemote(binding)
          const review = reviewExistingOrder(
            response.body,
            failedAwbInput.order_data,
            failedAwbInput.pickup_id,
            binding,
            failedAwbInput.native_order_id,
            failedAwbInput.courier_id,
            response.detail
          )
          if (review.ready && review.awb) verifiedAwb = review.awb
        } catch {
          // A failed read cannot prove that the assignment did not complete.
        }
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          verifiedAwb
            ? `Shiprocket assigned an AWB to order ${binding.order_id}, shipment ${binding.shipment_id}, despite the unconfirmed response.${diagnosticSuffix} Retry fulfillment on this same order to reuse its verified shipment; no order was cancelled or replaced.`
            : `Shiprocket did not confirm AWB assignment for order ${binding.order_id}, shipment ${binding.shipment_id}, reference ${binding.merchant_reference}.${diagnosticSuffix} The assignment may still complete. Check this same shipment in Shiprocket before retrying; no order was cancelled or replaced.`
        )
      }
      if (
        failedAwbInput &&
        awbRequested &&
        !awbPresent &&
        awbRejectionConfirmed
      ) {
        let outcome: Awaited<ReturnType<typeof cancelFailedAwbOrder>>
        try {
          outcome = await cancelFailedAwbOrder(
            await this.getSharedAxios(),
            failedAwbInput
          )
        } catch (cleanupError: any) {
          const reason =
            error instanceof MedusaError
              ? error.message
              : "Shiprocket did not confirm AWB assignment"
          throw new MedusaError(
            MedusaError.Types.NOT_ALLOWED,
            `${reason}${reason.includes(detail) ? "" : diagnosticSuffix}. Cancellation could not be confirmed: ${cleanupError.message}. Reconcile this same shipment before retrying; no replacement was created.`
          )
        }
        if (!outcome.cancelled)
          throw new MedusaError(
            MedusaError.Types.NOT_ALLOWED,
            `Shiprocket assigned an AWB despite the failed response.${diagnosticSuffix} Retry fulfillment on this same order to reuse its verified shipment; no order was cancelled or replaced.`
          )
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          `Shiprocket AWB assignment failed.${diagnosticSuffix} Its unbooked order was cancelled and cancellation confirmed. Retry fulfillment on this same order; the next attempt will use a new reference.`
        )
      }
      if (
        creationRequested &&
        (!error?.response ||
          [408, 425, 429, 500, 502, 503, 504].includes(
            error.response.status
          )) &&
        !(error instanceof MedusaError) &&
        !(error instanceof CourierQuoteError)
      )
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          resume
            ? `Shiprocket did not confirm AWB assignment for existing order ${resume.order_id}, shipment ${resume.shipment_id}. Reconcile that shipment before retrying; do not create a replacement.`
            : `Shiprocket did not confirm shipment creation for reference ${merchantReference}. An order may already exist. Reconcile that reference before retrying; do not create a replacement shipment.`
        )
      if (error instanceof MedusaError) throw error
      if (error instanceof CourierQuoteError)
        throw new MedusaError(MedusaError.Types.INVALID_DATA, error.message)
      handleError(error, { operation: "create", orderId: order?.id })
    }
  }

  /** Assign only a saved, verified native draft. No order creation, cancellation or pickup. */
  async assignDeferredAwb(
    data: any,
    fulfillmentId: string,
    options: {
      pending: boolean
      verifyBeforeAssign?: boolean
      beforeAssign: () => Promise<void>
    }
  ) {
    const snapshot = openAssignment(
      data.shiprocket_deferred_awb,
      fulfillmentId,
      assignmentSecret(this.assignmentKey)
    )
    const binding = snapshot.binding as ExistingOrderBinding
    validateExistingBinding(binding)
    if (
      snapshot.scope !== this.accountScope ||
      Number(data.order_id) !== binding.order_id ||
      Number(data.shipment_id) !== binding.shipment_id
    )
      throw new DeferredAwbError(
        "Shipment assignment ownership does not match this account"
      )
    const verify = async (budget = this.requestTimeout) => {
      const remote = await this.existingRemote(binding, budget)
      return reviewExistingOrder(
        remote.body,
        snapshot.order_data,
        snapshot.pickup_id,
        binding,
        snapshot.native_order_id,
        snapshot.quote.courier_company_id,
        remote.detail
      )
    }
    const result = (awb: string, amount = snapshot.quote.amount) => ({
      awb,
      tracking_number: awb,
      tracking_url: `https://shiprocket.co/tracking/${encodeURIComponent(awb)}`,
      courier_company_id: snapshot.quote.courier_company_id,
      courier_name: snapshot.quote.courier_name,
      shiprocket_awb_state: "assigned",
      shiprocket_carrier_cost: {
        amount,
        currency_code: "inr",
        courier_company_id: snapshot.quote.courier_company_id,
        service: snapshot.quote.service,
      },
    })
    const initial = await verify()
    if (!initial.ready)
      throw new DeferredAwbError(
        "Shipment does not match its saved assignment: " +
          initial.issues.join(", ")
      )
    if (initial.awb)
      return result(
        initial.awb,
        data.shiprocket_carrier_cost?.amount ?? snapshot.quote.amount
      )
    if (options.pending)
      throw new DeferredAwbError(
        "Shiprocket has not confirmed the earlier AWB request. Check AWB status for this shipment.",
        true,
        true
      )
    const quote = await this.quote(
      snapshot.quote_request,
      snapshot.quote,
      true,
      (actual) => {
        if (actual.amount > snapshot.quote.amount)
          throw Error(
            "The carrier rate increased since fulfillment. Review the shipment before assigning an AWB."
          )
      }
    )
    if (options.verifyBeforeAssign) {
      const latest = await verify()
      if (!latest.ready)
        throw new DeferredAwbError(
          "Shipment changed before retry: " + latest.issues.join(", ")
        )
      if (latest.awb)
        return result(
          latest.awb,
          data.shiprocket_carrier_cost?.amount ?? snapshot.quote.amount
        )
    }
    await options.beforeAssign()
    try {
      const response = await (
        await this.getSharedAxios()
      ).post(
        "/courier/assign/awb",
        {
          shipment_id: binding.shipment_id,
          courier_id: snapshot.quote.courier_company_id,
        },
        { shiprocket_order_id: snapshot.native_order_id } as any
      )
      const body = response.data,
        assigned = body?.response?.data
      if (
        [1, "1"].includes(body?.awb_assign_status) &&
        typeof assigned?.awb_code === "string" &&
        assigned.awb_code.trim() &&
        Number(assigned.courier_company_id) ===
          snapshot.quote.courier_company_id
      )
        return result(assigned.awb_code.trim(), quote.amount)
      const reason = this.carrierFailure(body)
      const upstream = Number(awbErrorDiagnostic(body).status_code)
      const uncertain =
        !!assigned?.awb_code ||
        ![0, "0"].includes(body?.awb_assign_status) ||
        [408, 425, 429].includes(upstream) ||
        upstream >= 500 ||
        /timeout|timed out|gateway/i.test(reason)
      if (!uncertain) throw new DeferredAwbError(reason, false)
    } catch (error: any) {
      if (error instanceof DeferredAwbError) throw error
      if (
        error?.response &&
        [400, 401, 403, 422, 429].includes(error.response.status)
      )
        throw new DeferredAwbError(
          this.carrierFailure(error.response.data),
          false
        )
    }
    const deadline = Date.now() + this.requestTimeout
    for (const delay of [0, 1000, 3000]) {
      if (Date.now() + delay >= deadline) break
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      try {
        const review = await verify(deadline - Date.now())
        if (review.ready && review.awb) return result(review.awb, quote.amount)
        if (
          review.issues.some((issue) =>
            [
              "order_cancellation",
              "shipment_cancellation",
              "pickup_state",
            ].includes(issue)
          )
        )
          break
      } catch {
        /* Reads cannot authorize another assignment POST. */
      }
    }
    throw new DeferredAwbError(
      "AWB assignment is unconfirmed. Retry this same action to read back the existing shipment; no replacement was created.",
      true
    )
  }

  /**
   * Cancel an order in Shiprocket
   */
  async cancel(orderId: string): Promise<void> {
    try {
      await (
        await this.getSharedAxios()
      ).post("/orders/cancel", { ids: [orderId] })
    } catch (error: any) {
      // Check if the order is already cancelled using specific status code / message
      const apiError = error?.response?.data
      const messageStr =
        typeof apiError === "string"
          ? apiError.toLowerCase()
          : (JSON.stringify(apiError ?? "")?.toLowerCase() ?? "")

      if (
        messageStr.includes("already cancelled") ||
        messageStr.includes("already canceled") ||
        (error?.response?.status === 400 &&
          messageStr.includes("cannot cancel"))
      ) {
        this.logger?.info(
          `[Shiprocket] Order ${orderId} is already cancelled/cannot be cancelled. Skipping error.`
        )
        return // Idempotent success
      }

      handleError(error, { operation: "cancel", orderId })
    }
  }

  /**
   * Schedule pickup for a shipment
   */
  private carrierFailure(body: any): string {
    const source = body && typeof body === "object" ? body : {}
    return (
      awbErrorSummary(
        awbErrorDiagnostic(
          {
            ...source,
            message:
              typeof body === "string"
                ? body
                : typeof source.message === "string"
                  ? source.message
                  : typeof source.response === "string"
                    ? source.response
                    : undefined,
          },
          [this.email, this.password, this.token]
        )
      ) || "Carrier did not confirm the operation"
    )
  }

  async schedulePickup(
    shipmentId: number | string,
    date?: Date
  ): Promise<boolean> {
    return (await this.requestPickup(shipmentId, date)).scheduled
  }

  /** Keep the carrier acknowledgement: HTTP success alone is not pickup success. */
  async requestPickup(
    shipmentId: number | string,
    date?: Date,
    retry = false
  ): Promise<{
    scheduled: boolean
    raw_response?: Record<string, unknown>
    message?: string
    uncertain?: boolean
    pickup_scheduled_date?: string
  }> {
    const id = Number(shipmentId)
    if (
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      (date && !Number.isFinite(date.getTime()))
    )
      return { scheduled: false }
    try {
      const payload: Record<string, unknown> = {
        shipment_id: [id],
        ...(retry ? { status: "retry" } : {}),
      }
      // Omitting a date lets Shiprocket select the next available pickup slot.
      if (date)
        payload.pickup_date = [
          new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Kolkata",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(date),
        ]
      const res = await (
        await this.getSharedAxios()
      ).post("/courier/generate/pickup", payload)
      const body = res.data?.data ?? res.data
      const scheduled = body?.pickup_status === 1
      if (!scheduled)
        this.logger?.warn(
          `Shiprocket pickup not confirmed: ${this.carrierFailure(body)}`
        )
      return {
        scheduled,
        ...(scheduled ? { raw_response: res.data } : {}),
        ...(!scheduled
          ? {
              message: this.carrierFailure(body),
              uncertain: body?.pickup_status !== 0,
            }
          : {}),
        ...(scheduled &&
        typeof body?.response?.pickup_scheduled_date === "string"
          ? { pickup_scheduled_date: body.response.pickup_scheduled_date }
          : {}),
      }
    } catch (error: any) {
      this.logger?.warn(
        "Shiprocket pickup request failed; verify carrier state before retrying"
      )
      return {
        scheduled: false,
        uncertain: ![400, 401, 403, 422, 429].includes(error?.response?.status),
        message: this.carrierFailure(error?.response?.data),
      }
    }
  }

  /** Read the exact shipment before pickup or document generation. No booking side effects. */
  async inspectPickup(
    fulfillment: any,
    awb: string
  ): Promise<{
    scheduled: boolean
    can_schedule: boolean
    failed?: boolean
    pickup_scheduled_date?: string
  }> {
    const id = Number(fulfillment.shipment_id)
    const orderId = Number(fulfillment.sr_order_id ?? fulfillment.order_id)
    if (
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      !Number.isSafeInteger(orderId) ||
      orderId <= 0
    )
      throw new Error("Invalid Shiprocket shipment binding")
    const res = await (await this.getSharedAxios()).get(`/shipments/${id}`)
    const shipment = res.data?.data ?? res.data
    if (
      Number(shipment?.id) !== id ||
      Number(shipment?.order_id) !== orderId ||
      String(shipment?.awb ?? shipment?.awb_code ?? "") !== awb
    )
      throw new Error("Shiprocket shipment binding does not match fulfillment")
    // Cancellation states must not be treated as scheduled from a retained timestamp.
    if (
      [8, 16].includes(Number(shipment.status_id ?? shipment.status)) ||
      /cancel/i.test(String(shipment.status))
    )
      throw new Error(
        "Shiprocket shipment is cancelled or cancellation is pending"
      )
    const code = Number(shipment.status_id ?? shipment.status)
    const failed =
      code === 13 || /^pickup error$/i.test(String(shipment.status))
    const canSchedule =
      failed ||
      [1, 2].includes(code) ||
      /^AWB ASSIGNED$/i.test(String(shipment.status))
    const date = shipment.pickup_scheduled_date
    const scheduled =
      !failed &&
      (Number(shipment.status_id ?? shipment.status) === 3 ||
        /^(pickup generated|pickup scheduled)$/i.test(
          String(shipment.status)
        ) ||
        !!shipment.pickup_token_number ||
        !!shipment.pickup_generated_date)
    return {
      scheduled,
      can_schedule: canSchedule,
      ...(failed ? { failed: true } : {}),
      ...(scheduled && typeof date === "string" && date
        ? { pickup_scheduled_date: date }
        : {}),
    }
  }

  /**
   * Get tracking information for a shipment
   */
  async getTrackingInfo(
    trackingNumber: string
  ): Promise<ShiprocketTrackingResponse> {
    try {
      const response = await (
        await this.getSharedAxios()
      ).get<ShiprocketTrackingResponse>(
        // encodeURIComponent so an unexpected value cannot alter the path.
        `/courier/track/awb/${encodeURIComponent(trackingNumber)}`
      )
      return response.data
    } catch (error: any) {
      handleError(error, { operation: "tracking" })
    }
  }

  /**
   * Create a return order in Shiprocket
   */
  async createReturn(fulfillment: any): Promise<ShiprocketCreateOrderResponse> {
    const returnData = {
      order_id: `${fulfillment.id}-${Math.floor(Date.now() / 1000)}`,
      order_date: new Date().toISOString().split("T")[0],

      // Pickup details (Customer returning the item)
      pickup_customer_name: requireField(
        fulfillment.pickup_address?.first_name || "Customer",
        "Pickup Customer Name"
      ),
      pickup_last_name: fulfillment.pickup_address?.last_name || "",
      pickup_address: requireField(
        fulfillment.pickup_address?.address_1,
        "Pickup Address"
      ),
      pickup_address_2: fulfillment.pickup_address?.address_2 || "",
      pickup_city: requireField(
        fulfillment.pickup_address?.city,
        "Pickup City"
      ),
      pickup_state: requireField(
        fulfillment.pickup_address?.province,
        "Pickup State"
      ),
      pickup_country: fulfillment.pickup_address?.country_code || "India",
      pickup_pincode: validateAndSanitizePincode(
        requireField(fulfillment.pickup_address?.postal_code, "Pickup Pincode"),
        "Pickup Pincode"
      ),
      pickup_email: fulfillment.email || "customer@example.com",
      pickup_phone: validateAndSanitizePhone(
        requireField(fulfillment.pickup_address?.phone, "Pickup Phone"),
        "Pickup Phone"
      ),

      // Shipping details (Warehouse receiving the returned item)
      shipping_customer_name:
        fulfillment.shipping_address?.first_name ||
        fulfillment.shipping_address?.company ||
        "Warehouse",
      shipping_last_name: fulfillment.shipping_address?.last_name || "",
      shipping_address: requireField(
        fulfillment.shipping_address?.address_1,
        "Shipping Address"
      ),
      shipping_address_2: fulfillment.shipping_address?.address_2 || "",
      shipping_city: requireField(
        fulfillment.shipping_address?.city,
        "Shipping City"
      ),
      shipping_state: requireField(
        fulfillment.shipping_address?.province,
        "Shipping State"
      ),
      shipping_country: fulfillment.shipping_address?.country_code || "India",
      shipping_pincode: validateAndSanitizePincode(
        requireField(
          fulfillment.shipping_address?.postal_code,
          "Shipping Pincode"
        ),
        "Shipping Pincode"
      ),
      shipping_email:
        fulfillment.shipping_address?.email || "warehouse@example.com",
      shipping_phone: validateAndSanitizePhone(
        requireField(fulfillment.shipping_address?.phone, "Shipping Phone"),
        "Shipping Phone"
      ),

      order_items:
        fulfillment.items?.map((item: any) => ({
          name: item.title,
          sku: item.sku || "RETURN-ITEM",
          units: item.quantity,
          selling_price: Math.round(Number(item.unit_price || 0)),
          discount: "",
          qc_enable: false,
        })) || [],
      payment_method: "Prepaid",
      total_discount: "0",
      sub_total: Math.round(Number(fulfillment.sub_total || 0)),
      length: shiprocketDimensionCm(fulfillment.length || 10, "return length"),
      breadth: shiprocketDimensionCm(fulfillment.breadth || 10, "return width"),
      height: shiprocketDimensionCm(fulfillment.height || 10, "return height"),
      weight: fulfillment.weight || 0.5,
    }

    try {
      const response = await (
        await this.getSharedAxios()
      ).post("/orders/create/return", returnData)
      return response.data
    } catch (error: any) {
      handleError(error, { operation: "createReturn" })
    }
  }

  /**
   * Generate documents (manifest, label, invoice) for a shipment
   */
  async createDocuments(
    fulfillment: any,
    options: {
      pickupConfirmed?: boolean
      awbConfirmed?: boolean
      pickupFailed?: boolean
    } = {}
  ): Promise<{
    manifest: string
    label: string
    invoice: string
    status?: Record<string, DocumentCheck>
  }> {
    const shipmentId = Number(fulfillment.shipment_id)
    const orderId = Number(fulfillment.sr_order_id ?? fulfillment.order_id)
    if (
      !Number.isSafeInteger(shipmentId) ||
      shipmentId <= 0 ||
      !Number.isSafeInteger(orderId) ||
      orderId <= 0
    )
      throw new Error("Valid Shiprocket order and shipment IDs are required")
    const status: Record<string, DocumentCheck> = {}
    if (options.pickupFailed)
      status.manifest = {
        available: false,
        message:
          "Shiprocket reports Pickup Error. Retry pickup before generating a manifest.",
      }
    const post = async (
      path: string,
      payload: any,
      key: string,
      flag: string,
      expected: any
    ): Promise<string> => {
      try {
        const res = await (await this.getSharedAxios()).post(path, payload)
        const body = res.data?.data ?? res.data
        const item = Array.isArray(body) ? body[0] : body
        const value = item?.[key]
        if ((!flag || item?.[flag] === expected) && typeof value === "string") {
          const url = new URL(value)
          if (url.protocol === "https:" && !url.username && !url.password) {
            if (!this.verifyDocuments) return value
            const checked = await checkDocument(value, this.requestTimeout)
            status[key.replace("_url", "")] = checked
            return checked.available ? value : ""
          }
        }
        status[key.replace("_url", "")] = {
          available: false,
          message: this.carrierFailure(item),
        }
        this.logger?.warn(
          `Shiprocket document unavailable at ${path}; carrier did not return a successful document URL; ${this.carrierFailure(item)}`
        )
      } catch (error: any) {
        // Only this documented, exact already-generated shipment permits print fallback.
        if (
          path === "/manifests/generate" &&
          Array.isArray(
            error?.response?.data?.already_manifested_shipment_ids
          ) &&
          error.response.data.already_manifested_shipment_ids.some(
            (id: any) => Number(id) === shipmentId
          )
        ) {
          return post(
            "/manifests/print",
            { order_ids: [orderId] },
            "manifest_url",
            "",
            undefined
          )
        }
        status[key.replace("_url", "")] = {
          available: false,
          http_status: error?.response?.status,
          message: this.carrierFailure(error?.response?.data),
        }
        this.logger?.warn(
          `Shiprocket document unavailable at ${path} (${error?.response?.status ?? "network"}); ${this.carrierFailure(error?.response?.data)}`
        )
      }
      return ""
    }
    const [manifest, label, invoice] = await Promise.all([
      options.pickupConfirmed && !options.pickupFailed
        ? post(
            "/manifests/generate",
            { shipment_id: [shipmentId] },
            "manifest_url",
            "status",
            1
          )
        : Promise.resolve(""),
      options.awbConfirmed === false
        ? Promise.resolve("")
        : post(
            "/courier/generate/label",
            { shipment_id: [shipmentId] },
            "label_url",
            "label_created",
            1
          ),
      post(
        "/orders/print/invoice",
        { ids: [orderId] },
        "invoice_url",
        "is_invoice_created",
        true
      ),
    ])
    return {
      manifest,
      label,
      invoice,
      ...(this.verifyDocuments || options.pickupFailed ? { status } : {}),
    }
  }

  /**
   * Generate label for a shipment
   */
  async generateLabel(fulfillment: any): Promise<string> {
    try {
      const res = await (
        await this.getSharedAxios()
      ).post("/courier/generate/label", {
        shipment_id: [fulfillment.shipment_id],
      })
      const data = res.data?.data || res.data
      const item = Array.isArray(data) ? data[0] : data
      if (item?.label_created !== 1 || typeof item?.label_url !== "string")
        return ""
      const url = new URL(item.label_url)
      return url.protocol === "https:" && !url.username && !url.password
        ? item.label_url
        : ""
    } catch {
      return ""
    }
  }

  /**
   * Generate invoice for an order
   */
  async generateInvoice(fulfillment: any): Promise<string> {
    try {
      const res = await (
        await this.getSharedAxios()
      ).post("/orders/print/invoice", {
        ids: [fulfillment.order_id],
      })
      const data = res.data?.data || res.data
      const item = Array.isArray(data) ? data[0] : data
      if (
        item?.is_invoice_created !== true ||
        typeof item?.invoice_url !== "string"
      )
        return ""
      const url = new URL(item.invoice_url)
      return url.protocol === "https:" && !url.username && !url.password
        ? item.invoice_url
        : ""
    } catch {
      return ""
    }
  }
}
