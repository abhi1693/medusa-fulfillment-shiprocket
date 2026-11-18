/**
 * Shiprocket API types
 */
export type ShiprocketClientOptions = {
  mode?: "test" | "live"
  email?: string
  password?: string
}

export type ShiprocketAuthResponse = {
  token: string
  success: boolean
  message: string
}

export type ShiprocketCalculateRateRequest = {
  pickup_postcode: string
  delivery_postcode: string
  weight: number
  cod: 0 | 1
  allowed_courier_ids?: string[]
}

export type ShiprocketCourierCompany = {
  courier_name: string
  courier_company_id: string
  rate: number
  estimated_delivery_days: number
}

export type ShiprocketCalculateRateResponse = {
  data: {
    available_courier_companies: ShiprocketCourierCompany[]
  }
}

export type ShiprocketOrderItem = {
  name: string
  sku: string
  units: number
  selling_price: number
  discount?: number
  tax?: number
  hsn?: string
}

export type ShiprocketCreateOrderRequest = {
  order_id: string
  order_date: string
  pickup_location: string
  billing_customer_name: string
  billing_last_name?: string
  billing_address: string
  billing_address_2?: string
  billing_city: string
  billing_pincode: string
  billing_state: string
  billing_country: string
  billing_email: string
  billing_phone: string
  shipping_is_billing: boolean
  shipping_customer_name?: string
  shipping_last_name?: string
  shipping_address?: string
  shipping_address_2?: string
  shipping_city?: string
  shipping_pincode?: string
  shipping_country?: string
  shipping_state?: string
  shipping_email?: string
  shipping_phone?: string
  order_items: ShiprocketOrderItem[]
  payment_method: "Prepaid" | "COD"
  sub_total: number
  length: number
  breadth: number
  height: number
  weight: number
}

export type ShiprocketCreateOrderResponse = {
  shipment_id: string
  status: string
  status_code: number
  awb?: string
  courier_company_id?: string
  tracking_number?: string
  tracking_url?: string
  label_url?: string
}

export type ShiprocketCancelOrderRequest = {
  ids: string[]
}

export type ShiprocketTrackingResponse = {
  tracking_data: {
    track_status: string
    shipment_status: string
    shipment_track: Array<{
      date: string
      status: string
      activity: string
      location: string
    }>
    etd?: string
    courier_name?: string
  }
  tracking_number?: string
  tracking_url?: string
  status?: string
  data?: any
  raw_response?: any
}

export type ShiprocketError = {
  message: string
  status_code: number
  errors?: Record<string, string[]>
}

export type Courier = {
  courier_name: string
  rate: number | string
  [key: string]: any
}
