import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import crypto from "crypto"
import { fail, isValidAwb, ok } from "../../../../shared/http"
import { RateLimiter, getClientIdentifier } from "../../../../shared/rate-limiter"

// Module identifier - must match what's registered in medusa-config.ts
const SHIPROCKET_TRACKING_MODULE = "shiprocketTrackingModuleService"
export const AUTHENTICATE = false

/** Minimum length for SHIPROCKET_WEBHOOK_TOKEN. 32 chars ~= 192 bits of entropy. */
const WEBHOOK_TOKEN_MIN_LENGTH = 32

/**
 * Per-client request cap for this unauthenticated endpoint. Stricter than the
 * public delivery-estimate limiter (30/min) because every request here is an
 * unauthenticated token guess attempt. Shiprocket itself sends well under this.
 */
const webhookRateLimiter = new RateLimiter(20, 60 * 1000)

/**
 * Constant-time string comparison to prevent timing attacks.
 * Uses crypto.timingSafeEqual to ensure comparison time is independent of input values.
 */
function constantTimeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(
        Buffer.from(a, 'utf8'),
        Buffer.from(b, 'utf8')
    )
}

interface ShiprocketWebhookScan {
    date: string
    status: string
    activity: string
    location: string
    "sr-status": string
    "sr-status-label": string
}

interface ShiprocketWebhookPayload {
    awb: string
    courier_name: string
    current_status: string
    current_status_id: number
    shipment_status: string
    shipment_status_id: number
    current_timestamp: string
    order_id: string
    sr_order_id: number
    awb_assigned_date?: string
    pickup_scheduled_date?: string
    etd?: string
    scans: ShiprocketWebhookScan[]
    is_return: 0 | 1
    channel_id?: number
    pod_status?: string
    pod?: string
}

const WEBHOOK_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000
const processedWebhookKeys = new Map<string, number>()

function cleanupProcessedWebhookKeys() {
    const now = Date.now()
    for (const [key, expiresAt] of processedWebhookKeys.entries()) {
        if (expiresAt <= now) {
            processedWebhookKeys.delete(key)
        }
    }
}

function getIdempotencyKey(payload: ShiprocketWebhookPayload): string {
    return `${payload.awb}:${payload.current_status_id || payload.current_status}:${payload.shipment_status_id || ""}:${payload.current_timestamp || "na"}`
}

function parseShiprocketDate(dateStr?: string): Date | undefined {
    if (!dateStr || typeof dateStr !== "string") return undefined
    // Strict "DD MM YYYY [HH:mm:ss]" (Shiprocket format) -> UTC
    const dmY = /^(\d{2}) (\d{2}) (\d{4})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(dateStr.trim())
    if (dmY) {
        const [, d, m, y, hh = "00", mm = "00", ss = "00"] = dmY
        const ms = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss))
        const dt = new Date(ms)
        return Number.isNaN(dt.getTime()) ? undefined : dt
    }
    // Strict "YYYY-MM-DD[ T]HH:mm:ss" -> UTC (avoid runtime-dependent local parsing)
    const ymd = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(dateStr.trim())
    if (ymd) {
        const [, y, m, d, hh = "00", mm = "00", ss = "00"] = ymd
        const ms = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss))
        const dt = new Date(ms)
        return Number.isNaN(dt.getTime()) ? undefined : dt
    }
    const fallback = new Date(dateStr)
    return Number.isNaN(fallback.getTime()) ? undefined : fallback
}

function sanitizeScans(scans: unknown): ShiprocketWebhookScan[] {
    if (!Array.isArray(scans)) return []
    return scans.slice(-200).filter((s): s is ShiprocketWebhookScan =>
        !!s && typeof s === "object" && typeof (s as any).date === "string" && typeof (s as any).status === "string"
    ).map((s) => ({
        date: String(s.date).slice(0, 64),
        status: String(s.status).slice(0, 256),
        activity: String((s as any).activity ?? "").slice(0, 1024),
        location: String((s as any).location ?? "").slice(0, 256),
        "sr-status": String((s as any)["sr-status"] ?? "").slice(0, 64),
        "sr-status-label": String((s as any)["sr-status-label"] ?? "").slice(0, 256),
    }))
}

/**
 * Shiprocket Webhook Endpoint
 * 
 * URL: POST /store/shiprocket/hook
 * 
 * Receives real-time shipment status updates from Shiprocket.
 * Token is validated via x-api-key header against SHIPROCKET_WEBHOOK_TOKEN env var.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const logger = req.scope.resolve("logger")

    try {
        // Brute-force guard. The token is the only authentication on this
        // unauthenticated endpoint, so a constant-time compare alone is not
        // enough: without a request cap an attacker can submit unlimited
        // guesses. Failed attempts are counted BEFORE any token comparison.
        const clientId = getClientIdentifier(req)
        if (!webhookRateLimiter.isAllowed(clientId)) {
            logger.warn("Shiprocket webhook: rate limit exceeded")
            return fail(res, 429, "RATE_LIMITED", "Too many requests")
        }

        // Validate webhook token (header may be string|string[])
        const rawToken = req.headers["x-api-key"]
        const token = Array.isArray(rawToken) ? rawToken[0] : rawToken
        const expectedToken = process.env.SHIPROCKET_WEBHOOK_TOKEN

        if (!expectedToken) {
            logger.warn("Shiprocket webhook: SHIPROCKET_WEBHOOK_TOKEN not configured")
            return fail(res, 500, "WEBHOOK_NOT_CONFIGURED", "Webhook not configured")
        }

        // Enforce an entropy floor. Previously any non-empty string (including
        // "123") was accepted, which makes the shared secret guessable and
        // renders the timing-safe comparison pointless.
        if (expectedToken.length < WEBHOOK_TOKEN_MIN_LENGTH) {
            logger.error("Shiprocket webhook: SHIPROCKET_WEBHOOK_TOKEN is too short")
            return fail(res, 500, "WEBHOOK_NOT_CONFIGURED", "Webhook not configured")
        }

        if (!token || typeof token !== "string" || !constantTimeCompare(token.trim(), expectedToken)) {
            logger.warn("Shiprocket webhook: Invalid or missing token")
            return fail(res, 401, "UNAUTHORIZED", "Unauthorized")
        }

        // Parse webhook payload
        const payload = req.body as ShiprocketWebhookPayload

        if (!payload?.awb || !isValidAwb(payload.awb)) {
            logger.warn("Shiprocket webhook: Missing or invalid AWB in payload")
            return fail(res, 400, "INVALID_PAYLOAD", "Invalid payload - missing or invalid AWB")
        }

        if (!payload.current_status || !payload.shipment_status) {
            return fail(res, 400, "INVALID_PAYLOAD", "Invalid payload - missing shipment status")
        }

        cleanupProcessedWebhookKeys()
        const idemKey = getIdempotencyKey(payload)
        if (processedWebhookKeys.has(idemKey)) {
            return ok(res, {
                message: "Webhook already processed",
                awb: payload.awb,
            })
        }

        // NOTE: the idempotency key is deliberately NOT claimed here. It is set
        // only after upsertByAwb() succeeds (see below). Claiming it up-front
        // meant that any failure below permanently swallowed retries: the key
        // stayed in the map, Shiprocket's retry hit the early return above, and
        // the tracking update was silently lost.

        if (processedWebhookKeys.size > 10000) {
            cleanupProcessedWebhookKeys()
        }

        logger.info(
            `Shiprocket webhook: Received update for AWB ${payload.awb} - ` +
            `Status: ${payload.current_status} (${payload.shipment_status_id})`
        )

        // Get tracking service
        const trackingService = req.scope.resolve<any>(SHIPROCKET_TRACKING_MODULE)

        // Parse dates from Shiprocket format (strict; invalid -> undefined, never Invalid Date)
        const parseDate = parseShiprocketDate

        // Extract Medusa Order ID from "order_id-timestamp" format
        // Shiprocket order_id is usually "order_id-timestamp" to ensure uniqueness
        let medusaOrderId = payload.order_id
        if (payload.order_id && payload.order_id.includes("-")) {
            const parts = payload.order_id.split("-")
            const lastPart = parts[parts.length - 1]
            // If last part is numeric timestamp, remove it
            if (/^\d+$/.test(lastPart)) {
                parts.pop()
                medusaOrderId = parts.join("-")
            }
        }

        // Upsert tracking record (cap free-form upstream strings before persistence)
        const tracking = await trackingService.upsertByAwb({
            awb: payload.awb,
            order_id: typeof payload.order_id === "string" ? payload.order_id.slice(0, 128) : payload.order_id,
            medusa_order_id: medusaOrderId, // Linked Medusa Order ID
            sr_order_id: payload.sr_order_id ? Number(payload.sr_order_id) : undefined,
            courier_name: typeof payload.courier_name === "string" ? payload.courier_name.slice(0, 256) : payload.courier_name,
            current_status: typeof payload.current_status === "string" ? payload.current_status.slice(0, 256) : payload.current_status,
            current_status_id: payload.current_status_id ? Number(payload.current_status_id) : undefined,
            shipment_status: typeof payload.shipment_status === "string" ? payload.shipment_status.slice(0, 256) : payload.shipment_status,
            shipment_status_id: payload.shipment_status_id ? Number(payload.shipment_status_id) : undefined,
            current_timestamp: parseDate(payload.current_timestamp),
            etd: parseDate(payload.etd),
            awb_assigned_date: parseDate(payload.awb_assigned_date),
            pickup_scheduled_date: parseDate(payload.pickup_scheduled_date),
            scans: sanitizeScans(payload.scans),
            pod_status: typeof payload.pod_status === "string" ? payload.pod_status.slice(0, 256) : payload.pod_status,
            pod: typeof payload.pod === "string" ? payload.pod.slice(0, 2048) : payload.pod,
            is_return: payload.is_return === 1,
            channel_id: payload.channel_id ? Number(payload.channel_id) : undefined,
            raw_payload: payload,
        })


        // Claim the idempotency key only now that the write has succeeded, so a
        // failure below still allows Shiprocket's retry to be processed.
        processedWebhookKeys.set(idemKey, Date.now() + WEBHOOK_IDEMPOTENCY_TTL_MS)

        logger.info(
            `Shiprocket webhook: Tracking updated for AWB ${payload.awb} - ` +
            `Record ID: ${tracking.id}`
        )

        // Emit event for subscribers to handle
        try {
            // Try v2 resolution first
            let eventBus: any = undefined;
            let isV2 = false;
            try {
                eventBus = req.scope.resolve("event_bus");
                isV2 = true;
            } catch (e) {
                // Fallback to v1
                try {
                    eventBus = req.scope.resolve("eventBusService");
                } catch (e2) {
                    logger.warn("Shiprocket webhook: Event bus not found, skipping event emission");
                }
            }

            if (eventBus && (eventBus as any).emit) {
                if (isV2) {
                    await (eventBus as any).emit({
                        name: "shiprocket.tracking.updated",
                        data: {
                            awb: payload.awb,
                            tracking_id: tracking.id,
                            current_status: payload.current_status,
                            shipment_status_id: payload.shipment_status_id,
                        }
                    })
                } else {
                    await (eventBus as any).emit("shiprocket.tracking.updated", {
                        awb: payload.awb,
                        tracking_id: tracking.id,
                        current_status: payload.current_status,
                        shipment_status_id: payload.shipment_status_id,
                    })
                }
            }
        } catch (eventErr) {
            logger.warn(`Shiprocket webhook: Failed to emit event: ${(eventErr as Error).message}`)
        }


        return ok(res, {
            message: "Webhook processed",
            awb: payload.awb,
        }, 200)
    } catch (error: any) {
        // Log message only. Passing the raw error risks dumping an axios error
        // whose `config.data` holds the Shiprocket login body (email/password)
        // and whose `config.headers` holds the bearer token.
        logger.error(
            `Shiprocket webhook error: ${error instanceof Error ? error.message : "unknown error"}`
        )
        return fail(res, 500, "INTERNAL_ERROR", "Internal server error")
    }
}
