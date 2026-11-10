## Unreleased — fulfillment and manual pickup linking

- Replace automatic pickup-address synchronization with explicit existing-ID linking.
- Add measured parcels, editable weight prefill and minimum outbound dimensions.
- Correct INR serialization and partial allocations; retain uncertain remote drafts.
- Include explicit same-mode courier UI and document its consuming-store API contract.
- Preserve request timeout options and sanitized timing/business-result diagnostics.
- Full sandbox AWB success and documented manifest sequencing remain unresolved.

# Changelog — @sam-ael/medusa-plugin-shiprocket

## 2.0.0 (2026-10-16) — Security hardening (breaking)

- **Breaking:** `GET /store/shiprocket/delivery-estimate` returns a generic failure message to anonymous callers. Upstream/axios details stay server-side (previously echoed, enabling serviceability probing).
- **Breaking:** Validation errors no longer echo submitted phone/pincode values (PII reached logs and admin error bodies). Messages report lengths only.
- Upstream `responseData.message` is only relayed when short and PII-free; otherwise generic.
- Tracking URLs are `encodeURIComponent`'d; admin document buttons require `https://`.
- Webhook no longer logs the secret's length on misconfiguration; free-form upstream strings are truncated before persistence.
- `calculatePrice` enforces `^\d{6}$` pincodes like the store route.
- Docs: AWB pattern corrected to `/^[A-Za-z0-9-]{6,40}$/`; store-tracking endpoint documented as ownership-verified, not public.
