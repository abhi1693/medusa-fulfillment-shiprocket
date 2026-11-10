# Merchant fulfillment adapter

The courier UI calls `GET` and `POST /admin/shiprocket-fulfillment/:id/couriers`. The consuming application must provide authenticated, authorized implementations for its merchant policy.

The GET response includes `shipping_option_id`, `location_id`, purchased `service`, pickup/destination PINs, remaining shipping budget, a revision digest, selected courier ID and eligible quotes with affordability. POST accepts only `shipping_option_id`, `courier_company_id`, and the revision digest. It must re-read the order, measured parcel, current courier eligibility, purchased transport mode and remaining budget before saving the explicit merchant selection.

Use the application's order-view permission for reads and order-management permission for selection. Coordinate selection with fulfillment through the application's supported locking provider. Selection must not reprice the customer, create a shipment, assign an AWB, schedule pickup or silently release a pending reservation. An existing unlinked AWB requires review before changing courier.

Customer-price rounding, payment, order-level reservation/recovery and any native resume wrapper are consuming-application concerns. The provider accepts signed pickup preflight, preserves the chosen courier and records carrier cost. This independently buildable package does not yet supply the merchant-policy API or a complete merchant-facing recovery flow.
