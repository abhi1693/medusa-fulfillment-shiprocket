export function remoteFixture(expected: any, binding: any): any {
  return {
    id: binding.order_id,
    channel_order_id: binding.merchant_reference,
    status: "NEW",
    currency: "INR",
    payment_method: "Prepaid",
    cod: 0,
    pickup_location_id: 123,
    customer_name: [
      expected.shipping_customer_name,
      expected.shipping_last_name,
    ]
      .filter(Boolean)
      .join(" "),
    customer_address: expected.shipping_address,
    customer_address_2: expected.shipping_address_2,
    customer_city: expected.shipping_city,
    customer_state: expected.shipping_state,
    customer_pincode: expected.shipping_pincode,
    customer_country: expected.shipping_country,
    customer_email: expected.shipping_email,
    customer_phone: expected.shipping_phone,
    billing_name: [expected.billing_customer_name, expected.billing_last_name]
      .filter(Boolean)
      .join(" "),
    billing_address: expected.billing_address,
    billing_address_2: expected.billing_address_2,
    billing_city: expected.billing_city,
    billing_state_name: expected.billing_state,
    billing_pincode: expected.billing_pincode,
    billing_country_name: expected.billing_country,
    billing_email: expected.billing_email,
    billing_phone: expected.billing_phone,
    total:
      Math.round(
        (expected.sub_total -
          expected.total_discount +
          expected.shipping_charges +
          (expected.giftwrap_charges || 0) +
          (expected.transaction_charges || 0)) *
          100
      ) / 100,
    discount: expected.total_discount,
    others: { shipping_charges: expected.shipping_charges },
    giftwrap_charges: 0,
    other_charges: 0,
    products: expected.order_items.map((p: any) => ({
      sku: p.sku,
      quantity: p.units,
      selling_price: p.selling_price,
      discount: p.discount,
      tax_percentage: p.tax,
    })),
    shipments: {
      id: binding.shipment_id,
      status: "PENDING",
      awb: "",
      courier_company_id: 0,
      weight: expected.weight,
      dimensions: [expected.length, expected.breadth, expected.height].join(
        "x"
      ),
    },
  }
}

export function shipmentDetailFixture(expected: any, binding: any): any {
  return {
    id: binding.shipment_id,
    order_id: binding.order_id,
    shipping_address: {
      address: expected.shipping_address,
      address_2: expected.shipping_address_2,
      city: expected.shipping_city,
      state: expected.shipping_state,
      pincode: expected.shipping_pincode,
      country: expected.shipping_country,
    },
    customer_details: {
      first_name: expected.shipping_customer_name,
      last_name: expected.shipping_last_name,
      phone: expected.shipping_phone,
    },
  }
}
