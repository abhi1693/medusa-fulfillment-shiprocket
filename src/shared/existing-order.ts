import { MedusaError } from "@medusajs/framework/utils"
import { createHash } from "node:crypto"
import { moneyPaise } from "./order-money"
export type ExistingOrderBinding = {
  order_id: number
  shipment_id: number
  merchant_reference: string
  workflow_transaction_id?: string
  review_digest?: string
}
export type ExistingOrderReview = {
  ready: boolean
  issues: string[]
  warnings: string[]
  digest: string
  order_id: number
  shipment_id: number
  awb: string
  courier_company_id?: number
  status: string
  expected: { total: number; discount: number; shipping: number }
}
const text = (v: unknown) =>
  String(v ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
const country = (v: unknown) =>
  ["in", "india"].includes(text(v)) ? "in" : text(v)
const city = (v: unknown) =>
  ["gurgaon", "gurugram"].includes(text(v)) ? "gurugram" : text(v)
const phone = (v: unknown) =>
  String(v ?? "")
    .replace(/\D/g, "")
    .replace(/^(?:91|0)(?=\d{10}$)/, "")
/** Pure comparison: never updates, creates, cancels or books a remote order. */
export function reviewExistingOrder(
  body: any,
  expected: any,
  pickupId: string,
  binding: ExistingOrderBinding,
  nativeOrderId: string,
  courierId: number,
  shipmentDetail?: any
): ExistingOrderReview {
  const remote = body?.data ?? body
  const issues: string[] = []
  const warnings: string[] = []
  const check = (ok: boolean, field: string) => {
    if (!ok) issues.push(field)
  }
  check(
    Number.isSafeInteger(binding.order_id) && binding.order_id > 0,
    "binding.order_id"
  )
  check(
    Number.isSafeInteger(binding.shipment_id) && binding.shipment_id > 0,
    "binding.shipment_id"
  )
  const legacy =
    binding.merchant_reference.startsWith(nativeOrderId + "-") &&
    /^\d{10}$/.test(binding.merchant_reference.slice(nativeOrderId.length + 1))
  check(
    binding.merchant_reference === expected.order_id || legacy,
    "merchant_reference.ownership"
  )
  check(Number(remote?.id) === binding.order_id, "order_id")
  check(
    remote?.channel_order_id === binding.merchant_reference,
    "merchant_reference"
  )
  const shipments = Array.isArray(remote?.shipments)
    ? remote.shipments
    : remote?.shipments
      ? [remote.shipments]
      : []
  const shipment = shipments.find(
    (s: any) => Number(s.id) === binding.shipment_id
  )
  check(shipments.length === 1 && !!shipment, "shipment_id")
  const status = String(remote?.status ?? "")
    .toUpperCase()
    .replace(/_/g, " ")
  check(["NEW", "AWB ASSIGNED"].includes(status), "order_status")
  check(
    ["NEW", "PENDING", "AWB ASSIGNED"].includes(
      String(shipment?.status ?? "")
        .toUpperCase()
        .replace(/_/g, " ")
    ),
    "shipment_status"
  )
  const awb = String(shipment?.awb || shipment?.awb_code || "")
  const assignedCourier = Number(
    shipment?.courier_company_id ||
      shipment?.courier_id ||
      remote?.courier_company_id ||
      0
  )
  check(!assignedCourier || assignedCourier === courierId, "courier_company_id")
  check(!awb || assignedCourier === courierId, "awb_courier")
  check(country(remote?.currency) === "inr", "currency")
  check(
    text(remote?.payment_method) === "prepaid" && !Number(remote?.cod || 0),
    "payment_method"
  )
  check(
    String(
      remote?.pickup_location_id ||
        remote?.pickup_id ||
        remote?.pickup_address?.id ||
        ""
    ) === String(pickupId),
    "pickup_id"
  )
  const compare = (
    actual: unknown,
    wanted: unknown,
    field: string,
    normalize = text
  ) => check(normalize(actual) === normalize(wanted), field)
  compare(
    remote?.customer_name,
    [expected.shipping_customer_name, expected.shipping_last_name]
      .filter(Boolean)
      .join(" "),
    "recipient.name"
  )
  for (const [actual, wanted] of [
    ["customer_address", "shipping_address"],
    ["customer_address_2", "shipping_address_2"],
    ["customer_city", "shipping_city"],
    ["customer_state", "shipping_state"],
    ["customer_pincode", "shipping_pincode"],
    ["customer_email", "shipping_email"],
  ])
    compare(
      remote?.[actual],
      expected[wanted],
      "recipient." + wanted,
      wanted === "shipping_city" ? city : text
    )
  compare(
    remote?.customer_country,
    expected.shipping_country,
    "recipient.country",
    country
  )
  const redacted = (value: unknown) =>
    /[xX*]/.test(String(value ?? "")) || !phone(value)
  let recipientPhone = remote?.customer_phone
  if (redacted(recipientPhone) && shipmentDetail) {
    const detail = shipmentDetail.data ?? shipmentDetail,
      address = detail.shipping_address,
      customer = detail.customer_details
    const matchingDetail =
      Number(detail.id) === binding.shipment_id &&
      Number(detail.order_id) === binding.order_id &&
      text(
        [customer?.first_name, customer?.last_name].filter(Boolean).join(" ")
      ) ===
        text(
          [expected.shipping_customer_name, expected.shipping_last_name]
            .filter(Boolean)
            .join(" ")
        ) &&
      text(address?.address) === text(expected.shipping_address) &&
      text(address?.address_2) === text(expected.shipping_address_2) &&
      city(address?.city) === city(expected.shipping_city) &&
      text(address?.state) === text(expected.shipping_state) &&
      text(address?.pincode) === text(expected.shipping_pincode) &&
      country(address?.country) === country(expected.shipping_country)
    if (matchingDetail && !redacted(customer?.phone))
      recipientPhone = customer.phone
  }
  const recipientPhoneVerified =
    !redacted(recipientPhone) &&
    phone(recipientPhone) === phone(expected.shipping_phone)
  check(
    recipientPhoneVerified,
    redacted(recipientPhone)
      ? "recipient.phone_unverifiable"
      : "recipient.phone"
  )
  compare(
    remote?.billing_name,
    [expected.billing_customer_name, expected.billing_last_name]
      .filter(Boolean)
      .join(" "),
    "billing.name"
  )
  for (const [actual, wanted] of [
    ["billing_address", "billing_address"],
    ["billing_address_2", "billing_address_2"],
    ["billing_city", "billing_city"],
    ["billing_state_name", "billing_state"],
    ["billing_pincode", "billing_pincode"],
    ["billing_email", "billing_email"],
  ])
    compare(
      remote?.[actual],
      expected[wanted],
      "billing." + wanted,
      wanted === "billing_city" ? city : text
    )
  compare(
    remote?.billing_country_name,
    expected.billing_country,
    "billing.country",
    country
  )
  if (redacted(remote?.billing_phone)) {
    if (
      recipientPhoneVerified &&
      phone(expected.billing_phone) === phone(expected.shipping_phone)
    )
      warnings.push("billing.phone_redacted")
    else check(false, "billing.phone_unverifiable")
  } else
    compare(
      remote.billing_phone,
      expected.billing_phone,
      "billing.phone",
      phone
    )
  const amount = (actual: unknown, wanted: unknown, field: string) => {
    try {
      check(moneyPaise(actual) === moneyPaise(wanted), field)
    } catch {
      check(false, field)
    }
  }
  const expectedTotal =
    Number(
      moneyPaise(expected.sub_total) -
        moneyPaise(expected.total_discount) +
        moneyPaise(expected.shipping_charges) +
        moneyPaise(expected.giftwrap_charges) +
        moneyPaise(expected.transaction_charges)
    ) / 100
  amount(remote?.total, expectedTotal, "amount.total")
  amount(remote?.discount, expected.total_discount, "amount.discount")
  amount(
    remote?.others?.shipping_charges ?? remote?.shipping_charges,
    expected.shipping_charges,
    "amount.shipping"
  )
  amount(
    remote?.giftwrap_charges ?? 0,
    expected.giftwrap_charges,
    "amount.giftwrap"
  )
  amount(
    remote?.other_charges ?? 0,
    expected.transaction_charges,
    "amount.transaction"
  )
  const rawProducts = remote?.products || remote?.order_products
  const products = Array.isArray(rawProducts) ? rawProducts : []
  const skus = expected.order_items.map((p: any) => String(p.sku))
  check(
    Array.isArray(products) &&
      products.length === skus.length &&
      new Set(skus).size === skus.length &&
      new Set(products.map((p: any) => String(p.channel_sku || p.sku))).size ===
        skus.length,
    "items.unique_skus"
  )
  for (const [index, item] of expected.order_items.entries()) {
    const product = products.find(
      (p: any) => String(p.channel_sku || p.sku) === String(item.sku)
    )
    check(
      Number(product?.quantity) === Number(item.units),
      `items.${index}.quantity`
    )
    amount(
      product?.selling_price,
      item.selling_price,
      `items.${index}.selling_price`
    )
    amount(product?.discount, item.discount, `items.${index}.discount`)
    check(
      Number(product?.tax_percentage) === Number(item.tax),
      `items.${index}.tax_rate`
    )
  }
  const dimensionValues = String(shipment?.dimensions || "")
    .split(/[x×]/i)
    .map(Number)
  for (const [index, field] of ["length", "breadth", "height"].entries()) {
    const actual = shipment?.[field] ?? dimensionValues[index]
    check(
      Number.isFinite(Number(actual)) &&
        Math.abs(Number(actual) - expected[field]) < 0.000001,
      "parcel." + field
    )
  }
  check(
    Number.isFinite(Number(shipment?.weight)) &&
      Math.abs(Number(shipment.weight) - expected.weight) < 0.000001,
    "parcel.weight"
  )
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        binding: {
          order_id: binding.order_id,
          shipment_id: binding.shipment_id,
          merchant_reference: binding.merchant_reference,
        },
        expected,
        pickupId,
        nativeOrderId,
        courierId,
        observed: {
          id: remote?.id,
          reference: remote?.channel_order_id,
          status,
          shipment_id: shipment?.id,
          shipment_status: shipment?.status,
          awb,
          courier: assignedCourier,
        },
        issues,
        warnings,
      })
    )
    .digest("hex")
  return {
    ready: issues.length === 0,
    issues,
    warnings,
    digest,
    order_id: binding.order_id,
    shipment_id: binding.shipment_id,
    awb,
    courier_company_id: assignedCourier || undefined,
    status,
    expected: {
      total: expectedTotal,
      discount: expected.total_discount,
      shipping: expected.shipping_charges,
    },
  }
}
export function requireExistingOrderReview(
  review: ExistingOrderReview,
  digest?: string
) {
  if (!review.ready)
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Existing Shiprocket order does not match: " +
        review.issues.join(", ") +
        ". Repair and verify it before resuming; no replacement shipment was created."
    )
  if (!digest || review.digest !== digest)
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Shiprocket reconciliation changed. Review the existing order again before resuming."
    )
}

export function validateExistingBinding(binding: ExistingOrderBinding) {
  if (
    !binding ||
    !Number.isSafeInteger(binding.order_id) ||
    binding.order_id <= 0 ||
    !Number.isSafeInteger(binding.shipment_id) ||
    binding.shipment_id <= 0 ||
    typeof binding.merchant_reference !== "string" ||
    binding.merchant_reference.length > 50 ||
    !binding.merchant_reference.length
  )
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Valid existing Shiprocket order, shipment and original reference are required"
    )
}
