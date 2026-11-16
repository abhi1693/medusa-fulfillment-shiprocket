# Merchant fulfillment adapter

The courier UI calls `GET` and `POST /admin/shiprocket-fulfillment/:id/couriers`. The consuming application must provide authenticated, authorized implementations for its merchant policy.

GET accepts `shipping_option_id`, optional stable `package_id` and optional `service` (`air` or `surface`). Omitting service checks the current merchant-selected mode. The response includes method/location/package IDs, requested `service`, current `selected_service`, original `checkout_service`, pickup/destination PINs, remaining shipping budget, a revision digest, selected courier ID and eligible quotes with their service and affordability. `affordable` is informational; eligible over-budget quotes remain selectable with a visible merchant-paid warning. POST accepts method/package IDs, `service`, `courier_company_id`, the displayed numeric `amount` and the revision digest. It must re-read the order, paid or measured parcel, current courier eligibility and remaining budget before saving the explicit merchant selection. Reject a different fresh price before persisting approval. Bind revisions to both the package and requested service; reject stale cross-service catalogs.

For paid package plans, expose selection on each remaining package and persist instructions in `metadata.shiprocket_package_couriers[package_id]`, including `shipping_option_id`, account scope, location, service, courier ID/name and amount. Earlier unplanned orders use `metadata.shiprocket_fulfillment_couriers[shipping_option_id]`. The public `fulfillmentCourier` helper validates and projects those instructions into fulfillment preflight without changing the signed paid quote. Preserve the cost allocations of other pending packages when checking an individual package's budget, then refresh all package rates before dispatch.

Use the application's order-view permission for reads and order-management permission for selection. Coordinate selection with fulfillment through the application's supported locking provider. Selection must not reprice the customer, create a shipment, assign an AWB, schedule pickup or silently release a pending reservation. An existing unlinked AWB requires review before changing courier.

Customer-price rounding, payment, order-level reservation/recovery and any native resume wrapper are consuming-application concerns. The provider accepts signed pickup preflight, preserves the chosen courier and records carrier cost. This independently buildable package does not yet supply the merchant-policy API or a complete merchant-facing recovery flow.

Signed preflight exposes `merchant_courier_selection` only when the matching
merchant instruction passed option/location/account/package validation. It
contains the selected courier, service and reviewed amount. The consuming cost
policy may permit this bounded price above the paid shipping budget; it must not
treat customer quote fields as merchant approval. Preserve refund and unknown
historic-cost checks, and count actual earlier package costs sequentially. Return
and persist `affordable`, `remaining_budget` and `over_budget_amount` for warnings
in confirmed package and legacy selection summaries.

A successful selection response includes `courier_company_id`, `courier_name`,
`service`, optional `package_id` and the fresh server-checked `amount`. The compact
Shipping card uses that response immediately, then refreshes native order/package
queries in the background. Initial rendering never fetches carrier rates. Opening
Change and switching service each fetch a fresh catalog. Cancellation discards
local edits; a failed or unconfirmed save cannot reuse an old catalog. A UI
request timeout does not prove the server stopped processing its request.
