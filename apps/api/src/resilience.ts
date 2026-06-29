// Circuit breakers + graceful degradation for external dependencies (Paddle,
// Postgres). A breaker tracks consecutive failures for ONE dependency; after
// `failureThreshold` it OPENS and fast-fails every call for `cooldownMs`
// instead of hammering a sick dependency (and piling up slow, timing-out
// requests). After the cooldown it goes HALF-OPEN and lets trial calls
// through; enough successes CLOSE it again, any failure re-OPENS it.
import { ApiError } from "./service"

export type CircuitState = "closed" | "open" | "half_open"

/**
 * Thrown when a breaker is open. Extends ApiError so the existing router catch
 * renders it as HTTP 503 service_unavailable with no extra wiring.
 */
export class DependencyUnavailableError extends ApiError {
    readonly dependency: string
    readonly retryAfterSeconds: number
    constructor(dependency: string, retryAfterSeconds: number) {
        super(`${dependency} is temporarily unavailable`, 503, "service_unavailable")
        this.name = "DependencyUnavailableError"
        this.dependency = dependency
        this.retryAfterSeconds = retryAfterSeconds
    }
}

export interface CircuitBreakerOptions {
    name: string
    /** Consecutive failures before the breaker opens. Default 5. */
    failureThreshold?: number
    /** How long the breaker stays open before a half-open trial. Default 30s. */
    cooldownMs?: number
    /** Successful half-open trials needed to fully close. Default 1. */
    successThreshold?: number
    /** Injectable clock (ms). Default Date.now. */
    now?: () => number
    onStateChange?: (state: CircuitState, name: string) => void
}

export class CircuitBreaker {
    readonly name: string
    private readonly failureThreshold: number
    private readonly cooldownMs: number
    private readonly successThreshold: number
    private readonly now: () => number
    private readonly onStateChange?: (state: CircuitState, name: string) => void

    private state: CircuitState = "closed"
    private failures = 0
    private successes = 0
    private openedAt = 0

    constructor(opts: CircuitBreakerOptions) {
        this.name = opts.name
        this.failureThreshold = opts.failureThreshold ?? 5
        this.cooldownMs = opts.cooldownMs ?? 30_000
        this.successThreshold = opts.successThreshold ?? 1
        this.now = opts.now ?? Date.now
        this.onStateChange = opts.onStateChange
    }

    getState(): CircuitState {
        return this.state
    }

    private transition(next: CircuitState): void {
        if (this.state === next) return
        this.state = next
        if (next === "closed") {
            this.failures = 0
            this.successes = 0
        } else if (next === "open") {
            this.openedAt = this.now()
            this.successes = 0
        } else if (next === "half_open") {
            this.successes = 0
        }
        this.onStateChange?.(next, this.name)
    }

    private retryAfterSeconds(): number {
        const remaining = this.cooldownMs - (this.now() - this.openedAt)
        return Math.max(1, Math.ceil(remaining / 1000))
    }

    async exec<T>(fn: () => Promise<T>): Promise<T> {
        if (this.state === "open") {
            if (this.now() - this.openedAt >= this.cooldownMs) {
                this.transition("half_open")
            } else {
                throw new DependencyUnavailableError(this.name, this.retryAfterSeconds())
            }
        }
        try {
            const result = await fn()
            this.onSuccess()
            return result
        } catch (e) {
            this.onFailure()
            throw e
        }
    }

    private onSuccess(): void {
        if (this.state === "half_open") {
            this.successes++
            if (this.successes >= this.successThreshold) this.transition("closed")
            return
        }
        this.failures = 0
    }

    private onFailure(): void {
        if (this.state === "half_open") {
            // A trial call failed -> straight back to open.
            this.transition("open")
            return
        }
        this.failures++
        if (this.failures >= this.failureThreshold) this.transition("open")
    }
}

export interface GuardOptions {
    /**
     * Method names to leave UNWRAPPED. Use for inbound verification (e.g. a
     * webhook handler) that must not trip the breaker on bad-actor traffic.
     */
    skip?: string[]
}

/**
 * Wrap every method of a dependency so each call flows through one breaker.
 * Non-function properties (and any names in opts.skip) pass through untouched.
 * Used to guard the Paddle billing client and the Postgres-backed Store without
 * hand-writing a proxy per method.
 */
export function guard<T extends object>(
    target: T,
    breaker: CircuitBreaker,
    opts: GuardOptions = {},
): T {
    const skip = new Set(opts.skip ?? [])
    return new Proxy(target, {
        get(obj, prop) {
            const value = Reflect.get(obj, prop)
            if (typeof value !== "function") return value
            const fn = value as (...a: unknown[]) => unknown
            if (typeof prop === "string" && skip.has(prop)) return fn.bind(obj)
            return (...args: unknown[]) =>
                breaker.exec(() => Promise.resolve(fn.apply(obj, args)))
        },
    }) as T
}