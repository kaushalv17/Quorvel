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

/**
 * Shared port implemented by every rate limiter. `check` may be synchronous
 * (in-memory) or asynchronous (Redis-backed); callers should await the result.
 */
export interface RateLimiterPort {
    check(key: string, now?: number): RateLimitResult | Promise<RateLimitResult>
}

/** Minimal Redis surface used by RedisRateLimiter (test seam). */
export interface RedisLike {
    eval(
        script: string,
        numKeys: number,
        ...args: Array<string | number>
    ): Promise<unknown>
    quit?(): Promise<unknown>
}

// Atomic fixed-window counter: INCR the key, set the TTL on the first hit, and
// report the live count + remaining TTL in a single round-trip. Shared by every
// instance pointed at the same Redis, so the cap is global rather than per-node.
const RL_SCRIPT = [
    "local c = redis.call('INCR', KEYS[1])",
    "if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end",
    "local ttl = redis.call('PTTL', KEYS[1])",
    "return { c, ttl }",
].join("\n")

/**
 * Redis-backed fixed-window limiter. Same window semantics as
 * FixedWindowRateLimiter, but the counter lives in Redis so the cap holds
 * across every API instance. Connects lazily (mirrors the BullMQ queue) and
 * accepts an injected client for tests.
 */
export class RedisRateLimiter implements RateLimiterPort {
    private client?: RedisLike
    constructor(
        private readonly max: number,
        private readonly windowMs: number = 60_000,
        private readonly opts: { redisUrl?: string; client?: RedisLike } = {},
    ) {
        if (opts.client) this.client = opts.client
    }

    private async connect(): Promise<RedisLike> {
        if (this.client) return this.client
        const IORedis = (await import("ioredis" as any)).default
        this.client = new IORedis(this.opts.redisUrl, {
            maxRetriesPerRequest: null,
        }) as RedisLike
        return this.client
    }

    async check(key: string): Promise<RateLimitResult> {
        const client = await this.connect()
        const raw = (await client.eval(
            RL_SCRIPT,
            1,
            `rl:${key}`,
            this.windowMs,
        )) as [number, number]
        const count = Number(raw[0])
        const ttl = Number(raw[1])
        return {
            allowed: count <= this.max,
            limit: this.max,
            remaining: Math.max(0, this.max - count),
            resetMs: ttl >= 0 ? ttl : this.windowMs,
        }
    }

    async close(): Promise<void> {
        if (this.client?.quit) await this.client.quit()
    }
}

/**
 * Build a limiter for the given per-minute cap. Uses Redis when a URL (or test
 * client) is provided so the cap is shared across instances; otherwise falls
 * back to the in-memory limiter, so local/dev and the sandbox are unchanged.
 */
export function createRateLimiter(
    max: number,
    opts: { windowMs?: number; redisUrl?: string; client?: RedisLike } = {},
): RateLimiterPort {
    const windowMs = opts.windowMs ?? 60_000
    if (opts.redisUrl || opts.client) {
        return new RedisRateLimiter(max, windowMs, {
            redisUrl: opts.redisUrl,
            client: opts.client,
        })
    }
    return new FixedWindowRateLimiter(max, windowMs)
}
