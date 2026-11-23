# Medusa Shiprocket Fulfillment

[![CI](https://github.com/abhi1693/medusa-fulfillment-shiprocket/actions/workflows/ci.yaml/badge.svg?branch=master)](https://github.com/abhi1693/medusa-fulfillment-shiprocket/actions/workflows/ci.yaml)
[![Medusa 2.22.4](https://img.shields.io/badge/Medusa-2.22.4-7c3aed)](https://docs.medusajs.com/)
[![MIT license](https://img.shields.io/github/license/abhi1693/medusa-fulfillment-shiprocket)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-abhi1693-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/abhi1693)

Connect Medusa stock locations to Shiprocket pickup addresses, quote live INR delivery rates at checkout, and create carrier orders from Medusa fulfillments. Staff can configure packing and whole-rupee rounding in Admin. The consuming application supplies the checkout and order-management adapters described in the [consumer integration guide](docs/CONSUMER_ADAPTER.md).

[Install](#install) · [Configure Medusa](#medusa-configuration) · [Map pickup addresses](#pickup-address-mappings) · [Set shipping rates](#rates-units-and-courier-choice) · [Carrier validation](#current-validation-and-remaining-carrier-limits)

## Install

```sh
npm install @abhi1693/medusa-fulfillment-shiprocket@0.0.2
```

## Requirements and local verification

Node >=22.22.0 (Docker pins 24.21.0), npm 12.2.2, Medusa 2.22.4, PostgreSQL and a configured Medusa event bus. The Admin build pins Medusa UI 4.2.11. Other Medusa versions have not been validated.

```sh
docker compose run --rm --build plugin-test
```

This clean standalone installation runs typechecking, offline tests, server/Admin build, declaration/export checks and an npm tarball inspection. It does not use the consuming store application code, a database, carrier credentials or real shipments. CI runs the same command. The Prepare release workflow builds and attests the npm tarball. Publishing the GitHub release starts the npm publisher, which verifies the archive and its provenance.

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
    dependencies: ["shiprocketConnection"],
    options: {
      providers: [{
        resolve: "@abhi1693/medusa-fulfillment-shiprocket",
        id: "shiprocket",
        options: {
          credential_store: true,
        },
      }],
    },
  }],
})
```

Run the consuming application's normal `medusa db:migrate`, then start it. Keep manual providers if your store also needs them. There is no store-specific activation switch in this package.

Database configuration:

Use the single Admin connection detail page to verify and save the API-user email/password and test/live mode. Manage activation, packing, couriers, timeout/cache, AWB/documents, diagnostics and webhook retention through Shipping settings. Store the same webhook token in Shiprocket's webhook configuration. The default API timeout is 60000 ms. No Shiprocket environment values are read, even when database credentials or settings are missing. Normal schema migrations create one disabled settings row; enabling shipping requires verified credentials and a webhook token. JWT_SECRET remains the deployment encryption/signing root. Internal deferred-AWB signing material is encrypted in the settings record and never exposed by Admin reads.

In Shiprocket **Settings → API**, enable **Buyer's Details Access → Allowed** for this API user as well as its required module permissions. Without buyer access, shipment GETs can return HTTP 200 with `Not Authorized` contact/address values. Existing-shipment verification remains blocked until access is fixed. See the official [API-user setup instructions](https://apidocs.shiprocket.in/?version=latest).

Never commit actual credentials. Sandbox authentication availability and rate limits remain carrier-controlled. Test mode is the validated integration focus; the standalone suite does not certify production carrier behavior.

## Pickup address mappings

The settings pickup table maps existing Shiprocket pickup addresses to existing Medusa stock locations. It does not create or delete addresses/locations or edit their names, contact details or physical addresses. Create, update and remove change only the established `shiprocket_pickup_id` and `shiprocket_pickup_scope` metadata keys through the public native update workflow. Multiple stock locations may share a pickup; each location keeps one pickup link. Pickup mapping is managed only from the settings table; no location-detail widget is registered.

`GET /admin/shiprocket-pickup-mappings` projects current pickup addresses and location associations; `POST` accepts strict `create`, `update` or `remove` commands bound to the connection scope and the location's revision. A fresh carrier lookup validates references before create/update; remove needs no carrier request. Mapping commands use a per-location public locking-module mutex and recheck native revisions after the carrier read. Stale/different-connection and missing-address associations remain visible for review. Native metadata updates outside these entry points are not a cross-module atomic transaction; no native tables are edited directly.

Consumers authorize reads with their stock-location/settings read capabilities, and writes with the owning stock-location management capability. A consuming application's adapter can declare these profiles separately from credential-management permissions. The reusable `source/admin/components/pickup-mappings` component takes `canRead` and `canWrite`; the host still enforces server authorization. It renders a searchable, paginated table, existing-record selectors, remove confirmation and read-only/error states. No pickup is scheduled by mapping an address.

## Multi-item package policy

Provider option `multiple_items` accepts `split_shipment` (default: one carrier order per physical unit) or `single_shipment` (one combined carrier order per pickup/shipping group). Quantity three produces three orders in split mode. Combined mode sums actual weights across quantities and quotes one package. Set `single_shipment_dimensions` to `largest_item` (default: all three dimensions from the greatest-volume unit) or `stacked` (maximum length/width and summed quantity-weighted heights). Configure these fields in Shipping → Packing. Invalid values are rejected at startup. Largest-item dimensions are an approximation, not proof that all contents fit that carton.

The paid signed package plan freezes quantities, measurements, strategy and carrier cost. Configuration/catalog changes cannot repartition it; a combined package must be fulfilled together. Existing split plans continue through their saved plan. Checkout pricing, package dispatch, courier selection and timeout recovery all use the same package snapshot. Separate AWB, pickup and document actions continue per resulting native fulfillment. Consumers still supply the public package/courier/recovery adapters described below.

For cables or other items with missing native shipping fields, opt into `missing_measurements: "use_defaults"`; the default `reject` preserves strict validation. Only null/undefined fields use defaults. Recorded variant/product values, including small actual weights, remain authoritative; malformed/nonpositive values still fail validation. Defaults are `default_item_weight_grams: 500` and `default_item_length_mm`, `default_item_width_mm`, `default_item_height_mm`: `6`. The weight matches Shiprocket's documented platform default; 6 mm is the smallest whole millimetre above its API's strict >0.5 cm dimension threshold, not a claimed default carton. All operational values come from the saved database settings. Custom default weights must be positive; default dimensions must exceed 5 mm. Resolved defaults are frozen into the signed paid measurements and never written back to the catalog.

## Pickup locations

Create and maintain saved pickup addresses in Shiprocket. In **Settings → Shiprocket → Pickup mappings**, map a stock location to one of the current account's existing addresses. The table saves the selected remote ID in `metadata.shiprocket_pickup_id`, with its account/mode scope. Linking and unlinking are local operations. No address create/update/sync workflow, subscriber or job remains; remote addresses and historic mappings are preserved. A service zone is still needed for native shipping options.

## Rates, units and courier choice

Prepaid only. Native unit weights are grams and dimensions millimetres; requests convert to kg/cm. Native attributes must describe each final packed sellable unit. Checkout quotes each distinct unit geometry, charges for every unit and offers only services available to every package. The signed paid quote retains the immutable package plan; later catalog edits do not change it. Native pricing-context hooks load required product measurements. Cart item mutations invalidate the selection without carrier requests; delivery-stage pricing fetches quotes.

`courier_selection=lowest_price|highest_rating` defaults to lowest price. Required filters are `require_real_time_tracking`, `pod_requirement=any|instant|on_request`, `require_call_before_delivery`. Unknown capabilities fail required filters. Optional preferences are `preferred_real_time_tracking`, `preferred_pod`, `preferred_call_before_delivery`; `courier_fallback=relax_preferences|none` defaults to relaxing optional call-before-delivery, then POD, then tracking, from the same returned list. Required serviceability, prepaid payment, positive cost and hard filters are never relaxed. No undocumented SLA adherence score is invented.

The quote includes the actual courier identity, price, ETA and any relaxed preferences. Selection must send the displayed signed `shiprocket_quote` in native shipping-method data; provider validation binds it to the cart/origin/account. Fulfillment revalidates the same courier and fails on material changes rather than silently substituting another carrier. Carrier-reported ETA is an estimate. Storefront presentation (such as Standard/Express), customer-price rounding and promotion policy belong to the consuming store; the consuming store merchant rounding adapter is deliberately excluded here.

## Measured parcels and fulfillment selection

**Shipping** replaces manual parcel entry. The compact card shows one current courier, its service and carrier amount, plus a single parcel-details line. Change opens an editor that loads courier choices automatically; switching Surface/Air refreshes them. Save courier confirms the selection and closes the editor; Cancel makes no change. Carrier IDs, route PINs and repeated warehouse/courier labels stay out of the summary. Create shipments through Medusa's native fulfillment form, one packed unit per fulfillment; the widget has no separate dispatch action or dispatch-result banner. The consuming application supplies the authorized `/admin/shiprocket-fulfillment/:id/packages` GET/POST orchestrator, performs all-package preflight and budget validation, and uses public native workflows with durable per-selection recovery. Successful packages remain fulfilled if a later package fails. The customer has one combined shipping charge. Factory multipacks are one parcel when their SKU measurements describe the whole packed carton. Legacy paid orders retain their existing recovery/measurement data and require review rather than silent conversion.

The package list rounds each displayed dimension upward to the next whole centimetre (for example 28.56 × 44.24 × 4.37 cm displays as 29 × 45 × 5 cm). Weight remains in kg with its original precision. This is presentation only; saved measurements, quote calculations and fulfillment requests retain their existing values.

Courier budgets are informational in the selection editor: over-budget choices
remain selectable and show an orange badge, the excess amount and a notice that
the merchant covers it. The confirmed summary retains that warning after save
and refresh. The application controls fulfillment cost policy. Signed pickup
preflight exposes `merchant_courier_selection` only for a validated explicit
order/package override, with its courier, service and reviewed price; customer
quote fields and request data cannot grant this approval. Applications can use
that bounded selection to permit extra merchant cost without repricing the order.

Known packed-unit selection and paid-plan validation failures use native HTTP 400 `invalid_data` responses, preserving actionable messages such as “Fulfill one packed unit at a time.” These helpers leave unexpected exceptions on the native generic-error path rather than exposing their internal messages. See [Medusa error handling](https://docs.medusajs.com/learn/fundamentals/api-routes/errors).

All transmitted length, breadth and height values are floored at 0.5 cm after conversion. Stored measurements remain unchanged. Serviceability and order creation use the same normalized dimensions; missing/invalid measurements remain errors.

The Admin courier selector lists current eligible alternatives with rate, ETA and budget state. The delivery-service control allows an explicit air/surface change before fulfillment. Orders with a paid package plan expose these controls on each pending package; earlier orders retain their order-detail courier widget. Each merchant instruction is bound to the current account, warehouse and shipping method, and planned-package instructions also bind the stable package ID. The signed customer quote remains unchanged. Its merchant-policy API is supplied by the consuming application; see [consumer adapter requirements](docs/CONSUMER_ADAPTER.md). This repository contains the reusable provider and UI, not the consuming store order-lock/recovery and customer-price policy. It is not yet a drop-in standalone implementation of that merchant API.

## Money and interrupted fulfillment

Medusa v2 amounts are already INR major units. The provider preserves paise, sends tax-inclusive item prices, explicit discounts and shipping, and gross goods `sub_total`; the observed carrier arithmetic subtracts `total_discount` and adds `shipping_charges`. Cumulative allocation preserves partial-fulfillment totals. The generic provider retains exact-rate validation; consuming stores can override `validateFulfillmentQuote` for an explicit shipping-budget policy while retaining courier/category validation.

Stable seller references and signed existing-order bindings support read-only review and reuse. AWB assignment has a 90-second request timeout; other calls keep their normal timeout. Only an explicit non-timeout AWB rejection (`awb_assign_status` 0) permits cleanup of a newly created, strictly verified unbooked draft. HTTP 504, transport timeouts, missing status and malformed success responses leave the outcome uncertain: the provider performs a read-only identity review and retains the same order/reference without cancelling or creating a replacement. A matching late AWB is retained for same-order reuse; cancellation-requested shipments stay blocked even if an AWB appears. Cancellation must be confirmed by another read before retry can use a fresh reference. Mismatches, booking/pickup history and unconfirmed cancellation remain blocked for review. Explicit existing-order resume bindings are never automatically cancelled by cleanup. The consuming app must coordinate durable reservations and the native idempotent workflow. No merchant-facing orphan-shipment recovery API is packaged here; recovery coordination must be provided by the consuming application.

Existing-shipment weight verification accepts Shiprocket's two-decimal shipment projection only when the order's original `others.weight` independently matches the expected declared weight and rounds to that projection (observed 0.163 kg → 0.16 kg). Missing or contradictory original evidence still blocks a rounded match. Exact legacy shipment weights retain the existing tiny floating-point tolerance. Other parcel, recipient, financial and remote-identity checks remain mandatory; native measurements and carrier quote inputs are unchanged.

## Webhooks, security and limits

The inbound route is `POST /hooks/fulfillment/delivery-updates`; configure the matching account webhook authentication header/token. Tracking reads enforce customer ownership. Raw webhook retention and cleanup are included. No npm publication, account changes, shipment booking, live payment or carrier cancellation occurs in the standalone tests.

Validate the full carrier lifecycle with your account before using this integration for real dispatch. The known limits below remain unresolved.

## License

MIT, original copyright (c) 2024 SAM-AEL; maintained adaptations by Abhimanyu Saharan. See `LICENSE` and `source.json`.

## Current validation and remaining carrier limits

The release suite exercises offline plugin tests, typechecking, server/Admin builds and package exports. These checks do not certify successful carrier AWB assignment. Actual sandbox AWB requests returned HTTP 200 with `awb_assign_status: 0` after roughly 31 seconds; the precise carrier rejection is unresolved. No automatic pickup is performed by fulfillment creation.

Manifest generation requires a confirmed pickup and submits the saved shipment ID. See [pickup and document verification](docs/pickup-documents.md) for the carrier prerequisites and the tested recovery behavior.

## Order widget availability

Shipping packages and legacy delivery selection render only after the backend confirms an enabled native Shiprocket provider and an applicable order shipping option with remaining shippable items. Stale quote metadata on manual, canceled or fully fulfilled orders does not display the controls. This check reads native Medusa data only and never authenticates to the carrier. Source widget exports are provided for consuming-application tests without copying package source.

## Split-origin carts

When no single location can supply a shipping profile, native inventory levels determine a signed per-origin quantity allocation. Pricing uses each shipment's assigned item weight rather than quoting the entire cart twice. Consumers can combine compatible Standard/Express quotes into one customer choice and submit all constituent options together through the native array shipping-method API. The allocation requires complete coverage and is rechecked before native completion. Existing single-origin alternatives remain unchanged.

Medusa 2.22.4 Query can return nullable relationships. Cart planning rejects an unresolved line item before allocating stock. The completion guard rejects an unresolved shipping method and accepts an ordinary custom method with no shipping option when it carries no Shiprocket allocation. The native Cart module defines `ShippingMethod.shipping_option_id` as nullable. [Query](https://docs.medusajs.com/learn/fundamentals/query) · [List cart shipping options](https://docs.medusajs.com/resources/references/medusa-workflows/listShippingOptionsForCartWorkflow)

The saved allocation binds each order fulfillment to its warehouse's item quantities and monetary share. Each shipment receives its own native shipping-method charge and budget. The consuming store owns rounding and the combined-price UI; its customer charge should sum the per-shipment prices after its rounding policy. No rate lookup creates a shipment or pickup. Carrier AWB and document-generation limitations described above still apply.

### Verified fulfillment recovery

The public client `recoverFailedFulfillment` validates the same expected payload and selected courier/budget before inspecting scoped merchant references. An active unbooked draft stays retained because an earlier AWB request may still finish. Automatic retry never cancels it. A fully matching AWB returns a resume binding, and a verified terminal unbooked cancellation permits a fresh reference (maximum 50 characters). Cancellation-requested, shipped, mismatched, ambiguous or native-linked shipments fail closed. No pickup is scheduled.

Callers must serialize each native order, persist attempt ownership/selection/account scope and reference, and distinguish finished failures from interrupted handlers. Trusted `no_previous_attempt` avoids history reads; `reference_hint` uses the documented channel-order filter and retains the reference if no result is visible. Bounded complete history inspection supports legacy timestamp references. Never choose the account's newest unrelated order. Pass the binding and reference through signed `prepareFulfillmentPickup` preflight; creation rejects arbitrary references.

The separate public client `inspectCancelledFulfillment(args, protectedOrderIds, referenceHint)` is read-only. It derives the original stable base from the trusted native financial snapshot and performs authenticated history/order GETs without checking the old courier or rates. Only an exact saved reference with verified unbooked, unlinked cancellations succeeds; active/pending, absent, contradictory, booked or pickup-marked records remain blocked. Its result includes `base_reference`, the next safe `reference`, and nonempty confirmed `cancelled_order_ids`. Consumers must retain the canceled reference by account scope/base so later dispatch of that package cannot reuse a permanently consumed reference after other packages finish. This method never clears native journals or reservations.

Shipment review normalizes native India province codes to carrier state names. New fulfillment requests send the state name while native addresses retain their original province keys. A redacted recipient phone can be corroborated only through matching shipment identity and destination. Shiprocket may return blank billing fields and top-level `shipping_is_billing=0` while preserving the original true flag in `others.shipping_is_billing`. Billing is then derived from the verified recipient only if the expected request explicitly uses the same address and all expected billing/recipient details agree. Partial contradictory billing, distinct billing, missing flags and unverifiable recipients remain blocked. The review records `billing.same_as_shipping` as a warning; parcel, courier, ownership and financial checks remain mandatory.

### Rate diagnostics

Rate calculation emits `Shiprocket rate input` and `Shiprocket rate decision` JSON records through the injected Medusa logger at info level. Turn off `rate_diagnostics` in Shipping settings to disable these records (HTTP and failure logging is independent). Inputs report an opaque route/parcel ID, kilograms/centimetres, prepaid mode, cache/API source and policy. Decisions report normalized courier IDs, air/surface service, INR rate, capabilities, hard rejection reasons, unmet preferences, winners and relaxed preferences, plus the ranking and relaxation order. `eligible_not_selected` means the candidate passed hard requirements but lost preference/ranking or explicit-courier selection; the record reports the applicable ranking and winners. No raw carrier response, postcode, customer contact/address, credential or signed token is logged. The correlation ID is diagnostic only, never an authorization or quote identifier. Merchant rounding, tax and presentation logs belong in the consuming application.

Authenticated cancellation notifications with an explicitly empty AWB, consistent cancellation statuses, a positive integer Shiprocket order ID and no AWB/pickup assignment dates receive HTTP 200 with `processed: true`, `reason: cancelled_before_awb`, and `sr_order_id`. They emit the public `shiprocket.order.cancelled` event (constant/type in `shared/order-cancellation`) carrying the numeric carrier ID, optional merchant reference, status fields and `before_awb: true`. Process-local dedupe includes the carrier order ID; failed event enqueue remains retryable. This is an advisory refresh hint, not refund evidence or permission to clear a journal, reserve budget or cancel native fulfillment. Retry verifies current carrier state through authenticated GETs even without a webhook. No tracking record or fake AWB is created. Missing/invalid AWBs on other events still return HTTP 400; authentication and rate limits apply first.

Status recognition follows the separate [official Orders and Shipments status tables](https://apidocs.shiprocket.in/): order cancellation codes 5/54, shipment cancellation codes 8/45, and pending order cancellation 18. Conflicting labels/codes and cross-namespace codes are rejected; a cancellation before dispatch still cannot erase prior AWB/pickup evidence.

## AWB assignment failure verification (2026-11-16)

Inspected the official Shiprocket API collection (https://apidocs.shiprocket.in/)
and its documented create-order, assign-AWB, get-order and cancel-order routes.
The installed API contracts and captured local test-mode responses distinguish
HTTP success from AWB assignment success and confirmed cancellation. The public
[Axios request configuration](https://axios-http.com/docs/req_config) supports per-request timeouts; 90 seconds applies
only to `/courier/assign/awb`. No assignment POST is retried automatically.

Offline regressions cover explicit rejection, transport timeout, a late successful
AWB, mismatched identities/financials, prior pickup history, cancellation not yet
confirmed and an AWB racing cancellation. Retry tests verify a fresh reference
for the same native order after confirmed cancellation. Clean Docker checks
include typecheck, tests, server/Admin build, exports and tarball inspection.
Consuming-application integration and live deployment require updating its exact
reviewed dependency pin; source tests alone do not change a running installation.

## AWB rejection diagnostics

The provider captures the documented `response.data.awb_assign_error` and
`response.action_required` fields, with string `message`/`error` fallbacks and
provider status codes, before cancellation. The rejection appears in structured
`Shiprocket AWB result` / `Shiprocket AWB failure` logs and survives both confirmed
and unconfirmed cancellation in the error delivered by native Medusa to Admin.
Unknown business rejections retain their text rather than only `unclassified`.
HTTP error response bodies use the same extraction; transport headers, request
configuration and complete response bodies are never serialized.

Diagnostic text is bounded (1000 characters for combined reasons, 300 for an
action) and redacts connection credentials, bearer/JWT tokens, URLs, email/phone
patterns and the current order's buyer names/contact/address fields. Redaction
preserves the surrounding carrier explanation. Only strings from declared error
fields are accepted. No AWB POST is replayed to obtain diagnostic data.

Contract source checked 2026-11-17:
https://apidocs-test.shiprocket.in/releases/2026-10/ (Couriers / Assign AWB).
Offline tests cover unclassified details, seller actions, malformed fields,
redaction, cancellation outcomes, HTTP errors and existing-only resume. Native
consuming tests check that public Medusa error handling preserves the reason and
action in the HTTP 400 message used by Admin while retaining same-order retry.

### Runtime shipping settings

The single connection module also owns a separate singleton operational-settings snapshot. Consuming Admin pages may import `source/admin/components/operational-settings` alongside the connection and pickup mapping components. Authenticated endpoints are `GET/POST /admin/shiprocket-settings/preferences`; applications must declare resource authorization for `settings.view` and `settings.manage`. Saves require verified credentials, strict validation and an expected revision. Runtime settings cover packing/courier rules, activation, timeouts, caching, AWB/document controls, diagnostics and webhook retention. The webhook token is encrypted, masked on reads and preserved when omitted. Environment values are never runtime fallbacks. Normal migrations initialize the disabled database singleton. Provider registration must remain present; runtime activation determines availability. Keep JWT/encryption root secrets in deployment configuration; deferred-assignment signing material is database-owned.

The settings components follow Medusa's detail-page UX: read-only summary cards with section action menus and Drawer editors. The consuming application's page can organize Connection, Shipping and Pickup mappings with public Tabs. Credential verification and revision checks remain enforced; closing a changed draft asks for confirmation. Essential help stays beside consequential actions rather than under every field.
