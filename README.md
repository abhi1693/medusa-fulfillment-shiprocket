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

Prepaid only. Native unit weights are grams and dimensions millimetres; requests convert to kg/cm. Native attributes must describe each final packed sellable unit. Checkout quotes each distinct unit geometry, charges for every unit and offers only services available to every package. The signed paid quote retains the immutable package plan; later catalog edits do not change it. Native pricing-context hooks load required product measurements. Cart item mutations invalidate the selection without carrier requests; delivery-stage pricing fetches quotes.

`SHIPROCKET_COURIER_SELECTION=lowest_price|highest_rating` defaults to lowest price. Required filters are `SHIPROCKET_REQUIRE_REAL_TIME_TRACKING`, `SHIPROCKET_POD_REQUIREMENT=any|instant|on_request`, `SHIPROCKET_REQUIRE_CALL_BEFORE_DELIVERY`. Unknown capabilities fail required filters. Optional preferences are `SHIPROCKET_PREFERRED_REAL_TIME_TRACKING`, `SHIPROCKET_PREFERRED_POD`, `SHIPROCKET_PREFERRED_CALL_BEFORE_DELIVERY`; `SHIPROCKET_COURIER_FALLBACK=relax_preferences|none` defaults to relaxing optional call-before-delivery, then POD, then tracking, from the same returned list. Required serviceability, prepaid payment, positive cost and hard filters are never relaxed. No undocumented SLA adherence score is invented.

The quote includes the actual courier identity, price, ETA and any relaxed preferences. Selection must send the displayed signed `shiprocket_quote` in native shipping-method data; provider validation binds it to the cart/origin/account. Fulfillment revalidates the same courier and fails on material changes rather than silently substituting another carrier. Carrier-reported ETA is an estimate. Storefront presentation (such as Standard/Express), customer-price rounding and promotion policy belong to the consuming store; the consuming store merchant rounding adapter is deliberately excluded here.

## Measured parcels and fulfillment selection

**Shipping packages** replaces manual parcel entry. The package list shows native packed measurements and carrier quotes. Dispatch packages creates one native partial fulfillment and ordinary Shiprocket order/AWB per physical unit. The consuming application supplies the authorized `/admin/shiprocket-fulfillment/:id/packages` GET/POST orchestrator, performs all-package preflight and budget validation, and uses public native workflows with durable per-selection recovery. Successful packages remain fulfilled if a later package fails. The customer has one combined shipping charge. Factory multipacks are one parcel when their SKU measurements describe the whole packed carton. Legacy paid orders retain their existing recovery/measurement data and require review rather than silent conversion.

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

Shipping packages and legacy delivery selection render only after the backend confirms an enabled native Shiprocket provider and an applicable order shipping option with remaining shippable items. Stale quote metadata on manual, canceled or fully fulfilled orders does not display the controls. This check reads native Medusa data only and never authenticates to the carrier. Source widget exports are provided for consuming-application tests without copying package source.

## Split-origin carts

When no single location can supply a shipping profile, native inventory levels determine a signed per-origin quantity allocation. Pricing uses each shipment's assigned item weight rather than quoting the entire cart twice. Consumers can combine compatible Standard/Express quotes into one customer choice and submit all constituent options together through the native array shipping-method API. The allocation requires complete coverage and is rechecked before native completion. Existing single-origin alternatives remain unchanged.

The saved allocation binds each order fulfillment to its warehouse's item quantities and monetary share. Each shipment receives its own native shipping-method charge and budget. The consuming store owns rounding and the combined-price UI; its customer charge should sum the per-shipment prices after its rounding policy. No rate lookup creates a shipment or pickup. Carrier AWB and document-generation limitations described above still apply.

### Verified fulfillment recovery

The public client `recoverFailedFulfillment` validates the same expected payload and selected courier/budget before inspecting scoped merchant references. A verified unbooked draft is cancelled, confirmed by readback, and replaced using a fresh reference (maximum 50 characters). A fully matching AWB returns a resume binding. Shipped, mismatched, ambiguous or native-linked shipments fail closed. No pickup is scheduled.

Callers must serialize each native order, persist attempt ownership/selection/account scope and reference, and distinguish finished failures from interrupted handlers. Trusted `no_previous_attempt` avoids history reads; `reference_hint` uses the documented channel-order filter and retains the reference if no result is visible. Bounded complete history inspection supports legacy timestamp references. Never choose the account's newest unrelated order. Pass the binding and reference through signed `prepareFulfillmentPickup` preflight; creation rejects arbitrary references.

Shipment review normalizes native India province codes to carrier state names. New fulfillment requests send the state name while native addresses retain their original province keys. A redacted recipient phone can be corroborated only through matching shipment identity and destination. Shiprocket may return blank billing fields and top-level `shipping_is_billing=0` while preserving the original true flag in `others.shipping_is_billing`. Billing is then derived from the verified recipient only if the expected request explicitly uses the same address and all expected billing/recipient details agree. Partial contradictory billing, distinct billing, missing flags and unverifiable recipients remain blocked. The review records `billing.same_as_shipping` as a warning; parcel, courier, ownership and financial checks remain mandatory.

### Rate diagnostics

Rate calculation emits `Shiprocket rate input` and `Shiprocket rate decision` JSON records through the injected Medusa logger at info level. Set `SHIPROCKET_RATE_DIAGNOSTICS=false` to disable these records (HTTP and failure logging is independent). Inputs report an opaque route/parcel ID, kilograms/centimetres, prepaid mode, cache/API source and policy. Decisions report normalized courier IDs, air/surface service, INR rate, capabilities, hard rejection reasons, unmet preferences, winners and relaxed preferences, plus the ranking and relaxation order. `eligible_not_selected` means the candidate passed hard requirements but lost preference/ranking or explicit-courier selection; the record reports the applicable ranking and winners. No raw carrier response, postcode, customer contact/address, credential or signed token is logged. The correlation ID is diagnostic only, never an authorization or quote identifier. Merchant rounding, tax and presentation logs belong in the consuming application.

Authenticated cancellation notifications with an explicitly empty AWB, both cancellation status labels, a positive integer Shiprocket order ID and no AWB/pickup assignment dates are acknowledged with HTTP 200 and `ignored: true`, `reason: cancelled_before_awb`. These order-only events create no tracking record and trigger no shipment mutation/event. Retries receive the same acknowledgement. Missing/invalid AWBs on other events still return HTTP 400; webhook authentication and rate limits apply before this exception.
