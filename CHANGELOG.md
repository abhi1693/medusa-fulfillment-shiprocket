# Changelog — @abhi1693/medusa-fulfillment-shiprocket

## 0.0.1

First public release under the `@abhi1693` scope.

### Database-backed Admin settings

- Store one verified test/live connection and encrypted operational settings in the owning module; remove carrier environment fallbacks.
- Add reusable native Admin connection, shipping and existing pickup-to-location mapping components with revision checks and permission boundaries.
- Keep deferred AWB signing material in the database, initialize disabled defaults through normal migrations and preserve pending assignments.
- Remove the redundant location widget and place courier budget details inside selectable cards.

### Fulfillment and manual pickup linking

- Replace automatic pickup-address synchronization with explicit existing-ID linking.
- Add measured parcels, editable weight prefill and minimum outbound dimensions.
- Correct INR serialization and partial allocations; retain uncertain remote drafts.
- Include explicit same-mode courier UI and document its consuming-store API contract.
- Preserve request timeout options and sanitized timing/business-result diagnostics.
- Handle nullable Medusa cart relations when preparing shipment plans.
- Require confirmed pickup for manifest generation, and preserve carrier identifiers across timeout recovery.

## Upstream history — @sam-ael/medusa-plugin-shiprocket

### 2.0.0 (2026-10-16) — Security hardening (breaking)

- **Breaking:** `GET /store/shiprocket/delivery-estimate` returns a generic failure message to anonymous callers. Upstream/axios details stay server-side (previously echoed, enabling serviceability probing).
- **Breaking:** Validation errors no longer echo submitted phone/pincode values (PII reached logs and admin error bodies). Messages report lengths only.
- Upstream `responseData.message` is only relayed when short and PII-free; otherwise generic.
- Tracking URLs are `encodeURIComponent`'d; admin document buttons require `https://`.
- Webhook no longer logs the secret's length on misconfiguration; free-form upstream strings are truncated before persistence.
- `calculatePrice` enforces `^\d{6}$` pincodes like the store route.
- Docs: AWB pattern corrected to `/^[A-Za-z0-9-]{6,40}$/`; store-tracking endpoint documented as ownership-verified, not public.
