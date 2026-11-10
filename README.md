# Medusa fulfillment Shiprocket

Shiprocket fulfillment and live delivery rates for Medusa v2. Package name: `@abhi1693/medusa-fulfillment-shiprocket`. No npm release has been published.

## Requirements and local verification

Node >=22.22.0 (Docker pins 24.21.0), npm 12.2.2, Medusa 2.22.4, PostgreSQL and a configured Medusa event bus. The Admin build pins Medusa UI 4.2.11. Other Medusa versions have not been validated.

```sh
docker compose run --rm --build plugin-test
```

This clean standalone installation runs typechecking, offline tests, server/Admin build, declaration/export checks and an npm tarball inspection. It does not use the consuming store application code, a database, carrier credentials or real shipments. CI runs the same command. `npm pack` creates a local archive only; there is no publishing job.

For a local consuming application, build this package, run `npm pack`, then install the resulting `.tgz` into your Medusa project. Pin reviewed HTTPS Git revisions for source installs. The package `prepare` script builds and checks its server/Admin/type exports during installation; approve only that exact reviewed revision in npm lifecycle policy.

## Medusa configuration

Register the plugin (for modules, migrations, routes, subscribers and Admin extensions) and its fulfillment provider:

```ts
import { defineConfig } from "@medusajs/framework/utils"

export default defineConfig({
  // Keep your existing projectConfig and unrelated modules.
  plugins: [{ resolve: "@abhi1693/medusa-fulfillment-shiprocket", options: {} }],
  modules: [{
    resolve: "@medusajs/medusa/fulfillment",
    options: {
      providers: [{
        resolve: "@abhi1693/medusa-fulfillment-shiprocket",
        id: "shiprocket",
        options: {
          mode: process.env.SHIPROCKET_MODE,
          email: process.env.SHIPROCKET_EMAIL,
          password: process.env.SHIPROCKET_PASSWORD,
        },
      }],
    },
  }],
})
```

Run the consuming application's normal `medusa db:migrate`, then start it. Keep manual providers if your store also needs them. There is no store-specific activation switch in this package.

Environment configuration:

- `SHIPROCKET_MODE=test|live` (default `test`) selects the endpoint internally. Test-only Origin/Referer headers never go to live mode.
- `SHIPROCKET_EMAIL` and `SHIPROCKET_PASSWORD`: API credentials. Login generates and caches the bearer token; no static API-token environment setting is required.
- `SHIPROCKET_WEBHOOK_TOKEN`: independent inbound webhook secret, at least 32 characters. Configure the same value on the Shiprocket account; do not confuse it with the generated API bearer.
- `SHIPROCKET_API_TIMEOUT_MS` (default 15000), `SHIPROCKET_WEBHOOK_PAYLOAD_RETENTION_DAYS` (default 30).

Never commit actual credentials. Sandbox authentication availability and rate limits remain carrier-controlled. Test mode is the validated integration focus; the standalone suite does not certify production carrier behavior.

## Pickup locations

Create and maintain saved pickup addresses in Shiprocket. On the Medusa location, **Link Shiprocket pickup address** lists the current account's existing addresses and saves the selected remote ID in `metadata.shiprocket_pickup_id`, with its account/mode scope. Linking and unlinking are local operations. No address create/update/sync workflow, subscriber or job remains; remote addresses and historic mappings are preserved. A service zone is still needed for native shipping options.

## Rates, units and courier choice

Prepaid only. Native unit weights are grams and dimensions millimetres; requests convert to kg/cm. Multi-item estimates sum weight times quantity and omit invented combined carton dimensions. Dispatch requires measured packed-parcel data. Native pricing-context hooks load required product measurements. Cart item mutations invalidate the selection without carrier requests; delivery-stage pricing fetches quotes.

`SHIPROCKET_COURIER_SELECTION=lowest_price|highest_rating` defaults to lowest price. Required filters are `SHIPROCKET_REQUIRE_REAL_TIME_TRACKING`, `SHIPROCKET_POD_REQUIREMENT=any|instant|on_request`, `SHIPROCKET_REQUIRE_CALL_BEFORE_DELIVERY`. Unknown capabilities fail required filters. Optional preferences are `SHIPROCKET_PREFERRED_REAL_TIME_TRACKING`, `SHIPROCKET_PREFERRED_POD`, `SHIPROCKET_PREFERRED_CALL_BEFORE_DELIVERY`; `SHIPROCKET_COURIER_FALLBACK=relax_preferences|none` defaults to relaxing optional call-before-delivery, then POD, then tracking, from the same returned list. Required serviceability, prepaid payment, positive cost and hard filters are never relaxed. No undocumented SLA adherence score is invented.

The quote includes the actual courier identity, price, ETA and any relaxed preferences. Selection must send the displayed signed `shiprocket_quote` in native shipping-method data; provider validation binds it to the cart/origin/account. Fulfillment revalidates the same courier and fails on material changes rather than silently substituting another carrier. Carrier-reported ETA is an estimate. Storefront presentation (such as Standard/Express), customer-price rounding and promotion policy belong to the consuming store; the consuming store merchant rounding adapter is deliberately excluded here.

## Measured parcels and fulfillment selection

**Packed parcel** on an order records actual outer-package weight in grams, dimensions in millimeters, and exact selected item quantities. Weight is prefilled from selected quantities with variant/product fallback and remains editable. The native fulfillment action must use that same selection. Saving a parcel never creates a shipment.

All transmitted length, breadth and height values are floored at 0.5 cm after conversion. Stored measurements remain unchanged. Serviceability and order creation use the same normalized dimensions; missing/invalid measurements remain errors.

The Admin courier widget lists current eligible alternatives in the customer's purchased air/surface category, with rate, ETA and budget state. Its merchant-policy API is supplied by the consuming application; see [consumer adapter requirements](docs/CONSUMER_ADAPTER.md). This repository contains the reusable provider and UI, not the consuming store order-lock/recovery and customer-price policy. It is not yet a drop-in standalone implementation of that merchant API.

## Money and interrupted fulfillment

Medusa v2 amounts are already INR major units. The provider preserves paise, sends tax-inclusive item prices, explicit discounts and shipping, and gross goods `sub_total`; the observed carrier arithmetic subtracts `total_discount` and adds `shipping_charges`. Cumulative allocation preserves partial-fulfillment totals. The generic provider retains exact-rate validation; consuming stores can override `validateFulfillmentQuote` for an explicit shipping-budget policy while retaining courier/category validation.

Stable seller references and signed existing-order bindings support read-only review and reuse. A carrier timeout or AWB failure retains the remote draft for review, without replacement creation, automatic cancellation or pickup. The consuming app must coordinate durable reservations and the native idempotent workflow. No merchant-facing orphan-shipment recovery API is packaged here; Recovery coordination must be provided by the consuming application.

## Webhooks, security and limits

The inbound route is `POST /hooks/fulfillment/delivery-updates`; configure the matching account webhook authentication header/token. Tracking reads enforce customer ownership. Raw webhook retention and cleanup are included. No npm publication, account changes, shipment booking, live payment or carrier cancellation occurs in the standalone tests.

Validate the full carrier lifecycle with your account before using this integration for real dispatch. The known limits below remain unresolved.

## License

MIT, original copyright (c) 2024 SAM-AEL; maintained adaptations by Abhimanyu Saharan. See `LICENSE` and `source.json`.

## Current validation and remaining carrier limits

The source passes 93 offline plugin tests, typechecking, server/Admin builds and package export checks. These checks do not certify successful carrier AWB assignment. Actual sandbox AWB requests returned HTTP 200 with `awb_assign_status: 0` after roughly 31 seconds; the precise carrier rejection is unresolved. No automatic pickup is performed by fulfillment creation.

The retained document generator currently requests a manifest using `order_ids` before a pickup. The sandbox lifecycle guide instead requires an assigned AWB plus requested pickup and a `shipment_id` array. That known discrepancy is deliberately recorded rather than silently changing lifecycle behavior. No npm release has been published.

## Order widget availability

Packed parcel and delivery selection render only after the backend confirms an enabled native Shiprocket provider and an applicable order shipping option with remaining shippable items. Stale quote metadata on manual, canceled or fully fulfilled orders does not display the controls. This check reads native Medusa data only and never authenticates to the carrier. Source widget exports are provided for consuming-application tests without copying package source.
