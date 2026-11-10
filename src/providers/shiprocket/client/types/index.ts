import type { CourierPolicyOptions as importPolicy } from "../../utils/courier-policy"
import type { AxiosError } from "axios"
import type { Logger } from "@medusajs/framework/types"

export interface ShiprocketClientOptions extends importPolicy {
  mode?: "test" | "live"
  email?: string
  password?: string
  timeout?: number
  logger?: Logger
}

export interface ShiprocketError {
  message: string
  errors?: Record<string, string | string[]>
}

export interface ShiprocketAuthResponse {
  token: string
}

export interface ShiprocketCalculateRateRequest {
  pickup_postcode: string
  delivery_postcode: string
  weight: number
  length?: number
  breadth?: number
  height?: number
  cod?: number
  declared_value?: number
  allowed_courier_ids?: number[]
}

export interface ShiprocketCourierCompany {
  id: number
  courier_name: string
  courier_company_id: number
  rate: string
  estimated_delivery_days: string // Shiprocket returns this, not "days"
  is_surface: boolean
  etd?: string // "Jan 14, 2026" format
  rating?: number | string
  realtime_tracking?: string
  pod_available?: string
  call_before_delivery?: string
  etd_hours?: number
}

export interface ShiprocketCalculateRateResponse {
  data: {
    available_courier_companies: ShiprocketCourierCompany[]
  }
}

export interface ShiprocketCreateOrderResponse {
  shiprocket_reconciled_existing?: boolean
  shiprocket_native_order_id?: string
  shiprocket_resume_transaction_id?: string
  shiprocket_native_selection?: { id: string; quantity: number }[]
  shiprocket_reconciliation_warnings?: string[]

  shiprocket_financials?: {
    goods_total: number
    tax_total: number
    shipping_total: number
    discount_total: number
    currency_code: string
  }
  shiprocket_merchant_reference?: string

  shiprocket_carrier_cost?: {
    amount: number
    currency_code: "inr"
    courier_company_id: number
    service: string | null
  }

  order_id: string | number
  shipment_id: string | number
  status?: string
  status_code?: number
  awb?: string
  courier_company_id?: number
  courier_name?: string
  tracking_number?: string
  tracking_url?: string
  label_url?: string
  payment_method?: string
  shipping_charges?: string
  transaction_charges?: string
  giftwrap_charges?: string
}

export interface ShiprocketTrackingResponse {
  tracking_data: {
    track_status: number | string
    shipment_status: number | string
    current_status: string
    etd?: string
    scans?: {
      date: string
      activity: string
      location: string
    }[]
    shipment_track?: {
      id: number
      awb_code: string
      courier_name: string
      pickup_date: string
      delivered_date: string
      weight: string
      origin: string
      destination: string
      current_status: string
      edd?: string
      pod?: string
      pod_status?: string
    }[]
    shipment_track_activities?: {
      date: string
      status: string
      activity: string
      location: string
      "sr-status": string | number
      "sr-status-label": string
    }[]
    courier_name?: string
    current_status_id?: number
    shipment_status_id?: number
    current_timestamp?: string
    awb_assigned_date?: string
    pickup_scheduled_date?: string
    pod_status?: string
    pod?: string
    is_return?: boolean
  }
}

export interface ShiprocketDeliveryEstimateRequest {
  pickup_postcode: string
  delivery_postcode: string
  weight?: number
  cod?: number
}

export interface ShiprocketDeliveryEstimate {
  courier_name: string
  courier_company_id: number
  estimated_days: number
  estimated_delivery_date: string
  rate: number
  is_surface: boolean
}

export interface ShiprocketDeliveryEstimateResponse {
  serviceable: boolean
  fastest_delivery: ShiprocketDeliveryEstimate | null
  cheapest_delivery: ShiprocketDeliveryEstimate | null
  all_options: ShiprocketDeliveryEstimate[]
}

export interface ShiprocketPickupLocation {
  id: number
  pickup_location: string // The location name/nickname
  name: string
  email?: string
  phone: string
  address: string
  address_2?: string
  city: string
  state: string
  country: string
  pin_code: string
  lat?: string
  long?: string
  status: number
  rto_address_id?: number
  new: number
}

export interface ShiprocketPickupLocationsResponse {
  data: {
    shipping_address: ShiprocketPickupLocation[]
  }
}

export type { AxiosError }
