// Simple in-memory fixed-window rate limiter + caller identification.
// PER-CALLER buckets cap abuse on a SINGLE instance so one noisy key (or a
// pre-auth IP) can't exhaust the shared $0 infra or trip the limit for everyone
// else. For multi-instance deployments back this with Redis (INCR + EXPIRE) so
// the window is shared. See PRODUCTION-RUNBOOK.md (Phase 3).
import { createHash } from "node:crypto"

export interface RateLimitResult {
    allowed: boolean
    limit: number
    remaining: number
    resetMs: number
}

interface Bucket {
    count: number
    resetAt: number
}

export class FixedWindowRateLimiter {
    private readonly hits = new Map<string, Bucket>()
    constructor(
        private readonly max: number,
        private readonly windowMs: number = 60_000,
    ) {}

    check(key: string, now: number = Date.now()): RateLimitResult {
        let bucket = this.hits.get(key)
        if (!bucket || now >= bucket.resetAt) {
            bucket = { count: 0, resetAt: now + this.windowMs }
            this.hits.set(key, bucket)
        }
        bucket.count++
        const remaining = Math.max(0, this.max - bucket.count)
        return {
            allowed: bucket.count <= this.max,
            limit: this.max,
            remaining,
            resetMs: bucket.resetAt - now,
        }
    }

    /** Drop expired buckets. Call periodically if the keyspace is large. */
    sweep(now: number = Date.now()): void {
        for (const [k, b] of this.hits) {
            if (now >= b.resetAt) this.hits.delete(k)
        }
    }

    /** Number of live buckets (used by tests + memory diagnostics). */
    get size(): number {
        return this.hits.size
    }
}

export interface CallerId {
    /** Stable bucket id. Never contains the raw secret token. */
    id: string
    /** True when the caller presented an API key or org context. */
    authenticated: boolean
}

function firstHeader(v: string | string[] | undefined): string | undefined {
    if (Array.isArray(v)) return v[0]
    return v || undefined
}

// Derive a STABLE per-caller bucket id WITHOUT storing the secret in memory.
// Priority: API key (hashed Bearer) -> Clerk org -> client IP.
export function identifyCaller(input: {
    authorization?: string | string[] | undefined
    orgId?: string | string[] | undefined
    ip?: string | undefined
}): CallerId {
    const auth = firstHeader(input.authorization)
    const bearer = auth ? /^Bearer\s+(.+)$/i.exec(auth)?.[1] : undefined
    if (bearer) {
        const digest = createHash("sha256").update(bearer).digest("hex").slice(0, 16)
        return { id: `key:${digest}`, authenticated: true }
    }
    const org = firstHeader(input.orgId)
    if (org) return { id: `org:${org}`, authenticated: true }
    return { id: `ip:${input.ip || "anon"}`, authenticated: false }
}