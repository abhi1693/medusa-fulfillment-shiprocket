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
  private policy: CourierPolicy
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
    if (!fresh && cached && Date.now() - cached.timestamp < this.CACHE_TTL)
      return cached.rows
    const pending = this.rateRequests.get(key)
    if (pending) return pending
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
    return courierChoices(
      await this.courierRows(data),
      this.policy,
      data.allowed_courier_ids
    )
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
    const quote = selectCourier(
      await this.courierRows(data, fresh),
      this.policy,
      data.allowed_courier_ids,
      selectedId
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

    // Calculate totals and dimensions
    for (const item of items) {
      const orderItem = orderItemMap.get(item.line_item_id)
      if (!orderItem) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Order item not found for fulfillment item: ${item.title}`
        )
      }

      const variant = orderItem.variant
      if (!variant) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Variant data missing for item: ${item.title}`
        )
      }

      const product = (variant as any).product

      const {
        weightKg: weight,
        length,
        width: breadth,
        height,
      } = getLineItemDimensions(variant, itemMeasurements?.[orderItem.id])

      // Strict Validation: Shiprocket fines for incorrect dimensions
      if (
        !measuredParcel &&
        ![weight, length, breadth, height].every(
          (value) => Number.isFinite(value) && value > 0
        )
      ) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Missing dimensions/weight for "${item.title}". Please set them on the Variant or Product.`
        )
      }

      const quantity = Number(item.quantity || item.raw_quantity?.value || 1)
      totalUnits += quantity
      totalWeight += weight * quantity
      totalLength = Math.max(totalLength, length)
      totalBreadth = Math.max(totalBreadth, breadth)
      totalHeight += height * quantity
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
        "Measured packed parcel is required for multi-item Shiprocket fulfillment"
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
        billing.province || shipping.province,
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
      shipping_state: requireField(shipping.province, "Shipping State"),
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

  private async existingRemote(binding: ExistingOrderBinding) {
    validateExistingBinding(binding)
    const api = await this.getSharedAxios(),
      response = await api.get(`/orders/show/${binding.order_id}`)
    const remote = response.data?.data ?? response.data
    let detail: any
    if (
      /[xX*]/.test(String(remote?.customer_phone ?? "")) ||
      !String(remote?.customer_phone ?? "").replace(/\D/g, "")
    ) {
      const shipment = await api.get(`/shipments/${binding.shipment_id}`)
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
    resume?: ExistingOrderBinding
  ): Promise<ShiprocketCreateOrderResponse> {
    let creationRequested = false
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
          ).post("/courier/assign/awb", awbPayload, {
            shiprocket_order_id: order.id,
          } as any)

      const awbStatus = awbCreated.data?.awb_assign_status
      const responseBody = awbCreated.data?.response?.data
      const rawReasons = [
        awbCreated.data?.message,
        awbCreated.data?.error,
        awbCreated.data?.response?.message,
        awbCreated.data?.response?.error,
        responseBody?.awb_assign_error,
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
          `Shiprocket did not assign an AWB for existing order ${orderCreated.data.order_id}, shipment ${orderCreated.data.shipment_id} (${reason}). The draft is retained for review; no replacement or pickup was created.`
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
  async schedulePickup(
    shipmentId: number | string,
    date?: Date
  ): Promise<boolean> {
    try {
      const pickupDate = date || new Date()

      // Shiprocket operates on IST: format the pickup date in Asia/Kolkata,
      // otherwise an evening-IST fulfillment formats as "yesterday" in UTC.
      const istParts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(pickupDate)
      // en-CA yields YYYY-MM-DD
      const dStr = istParts
      const numericShipmentId = Number(shipmentId)
      if (!Number.isFinite(numericShipmentId)) {
        this.logger?.warn(
          `Shiprocket: invalid shipment_id for pickup: ${String(shipmentId)}`
        )
        return false
      }

      await (
        await this.getSharedAxios()
      ).post("/courier/generate/pickup", {
        shipment_id: [numericShipmentId],
        pickup_date: [dStr],
      })

      this.logger?.info(
        `Shiprocket: Successfully scheduled pickup for shipment ${shipmentId}`
      )
      return true
    } catch (error: any) {
      // We only log warning instead of failing the fulfillment because the AWB is already assigned
      this.logger?.warn(
        `Shiprocket: Failed to schedule pickup for shipment ${shipmentId}. You may need to schedule it manually in the Shiprocket dashboard. Error: ${error?.response?.data?.message || error.message}`
      )
      return false
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
  async createDocuments(fulfillment: any): Promise<{
    manifest: string
    label: string
    invoice: string
  }> {
    // Shiprocket tolerates a document failing to generate (e.g. an AWB not yet
    // assigned), so these calls stay non-fatal. But the failure must be
    // visible: previously only console.error fired, so a fulfilment could
    // silently end up with no label. Log through the module logger with a
    // status code only — never the raw response body, which can echo the
    // request payload containing customer PII.
    const safePost = async (url: string, data: any) =>
      (await this.getSharedAxios()).post(url, data).catch((err: any) => {
        const status = err?.response?.status ?? "network"
        this.logger?.warn?.(
          `Shiprocket document generation failed at ${url} (${status}); ` +
            `continuing without that document.`
        )
        return { data: null }
      })

    // Shiprocket expects arrays for IDs even if it's just one.
    // NOTE: manifests are generated per Shiprocket order_id, labels per shipment_id.
    const [manifestRes, labelRes, invoiceRes] = await Promise.all([
      safePost("/manifests/generate", { order_ids: [fulfillment.order_id] }),
      safePost("/courier/generate/label", {
        shipment_id: [fulfillment.shipment_id],
      }),
      safePost("/orders/print/invoice", { ids: [fulfillment.order_id] }),
    ])

    const extractUrl = (
      res: any,
      key: string,
      checkKey?: string,
      checkVal?: any
    ) => {
      if (!res?.data) return ""
      const item = Array.isArray(res.data) ? res.data[0] : res.data

      // Handle cases where Shiprocket returns { status: 1, manifest_url: "..." }
      const data = res.data?.data || res.data
      const target = Array.isArray(data) ? data[0] : data

      if (!target) return ""
      if (checkKey && target[checkKey] !== checkVal) return ""
      return target[key] || ""
    }

    return {
      manifest: extractUrl(manifestRes, "manifest_url", "status", 1),
      label: extractUrl(labelRes, "label_url", "label_created", 1),
      invoice: extractUrl(
        invoiceRes,
        "invoice_url",
        "is_invoice_created",
        true
      ),
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
      return item?.label_url || ""
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
      return item?.invoice_url || ""
    } catch {
      return ""
    }
  }
}
