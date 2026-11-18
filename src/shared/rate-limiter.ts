/**
 * Simple in-memory rate limiter using sliding window
 * Limits requests per IP address
 */

interface RateLimitEntry {
    count: number
    windowStart: number
}

export class RateLimiter {
    private requests = new Map<string, RateLimitEntry>()
    private readonly maxRequests: number
    private readonly windowMs: number
    private readonly maxCacheSize = 10000 // Prevent unbounded memory growth

    constructor(maxRequests: number = 30, windowMs: number = 60 * 1000) {
        // Default: 30 requests per minute per IP
        this.maxRequests = maxRequests
        this.windowMs = windowMs

        // Cleanup old entries every 5 minutes (unref so it never keeps the process alive)
        const timer = setInterval(() => this.cleanup(), 5 * 60 * 1000)
        if (typeof (timer as any).unref === "function") {
            ;(timer as any).unref()
        }
    }

    /**
     * Check if request should be allowed
     * @returns true if allowed, false if rate limited
     */
    isAllowed(identifier: string): boolean {
        // Force cleanup if cache grows too large
        if (this.requests.size >= this.maxCacheSize) {
            this.cleanup()
        }

        const now = Date.now()
        const entry = this.requests.get(identifier)

        if (!entry) {
            // First request from this identifier
            this.requests.set(identifier, { count: 1, windowStart: now })
            return true
        }

        // Check if window has expired
        if (now - entry.windowStart > this.windowMs) {
            // Reset window
            this.requests.set(identifier, { count: 1, windowStart: now })
            return true
        }

        // Window still active
        if (entry.count >= this.maxRequests) {
            return false
        }

        // Increment count
        entry.count++
        return true
    }

    /**
     * Get remaining requests for an identifier
     */
    getRemaining(identifier: string): number {
        const entry = this.requests.get(identifier)
        if (!entry) return this.maxRequests

        const now = Date.now()
        if (now - entry.windowStart > this.windowMs) {
            return this.maxRequests
        }

        return Math.max(0, this.maxRequests - entry.count)
    }

    /**
     * Get time until rate limit resets (in seconds)
     */
    getResetTime(identifier: string): number {
        const entry = this.requests.get(identifier)
        if (!entry) return 0

        const now = Date.now()
        const resetAt = entry.windowStart + this.windowMs
        return Math.max(0, Math.ceil((resetAt - now) / 1000))
    }

    /**
     * Clean up expired entries
     */
    private cleanup(): void {
        const now = Date.now()
        for (const [key, entry] of this.requests.entries()) {
            if (now - entry.windowStart > this.windowMs) {
                this.requests.delete(key)
            }
        }
    }
}

// Singleton rate limiter: 30 requests per minute
export const rateLimiter = new RateLimiter(30, 60 * 1000)

/**
 * Get client identifier from request (IP address).
 * NOTE: X-Forwarded-For / X-Real-IP are only trustworthy behind a verified
 * proxy. Prefer the framework-resolved IP first so clients cannot rotate
 * buckets by spoofing headers; headers are a fallback only.
 */
export function getClientIdentifier(req: any): string {
    const direct = req.ip || req.socket?.remoteAddress
    if (direct && direct !== "unknown") {
        return String(direct)
    }
    const forwarded = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
    return forwarded || req.headers["x-real-ip"] || "unknown"
}
