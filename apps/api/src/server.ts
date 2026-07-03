// Thin Fastify adapter. It only translates HTTP <-> RawRequest/RawResponse and
// delegates ALL logic to handleRequest (router.ts), so what we unit-test is what
// serves traffic.
import Fastify from "fastify"
import { randomUUID } from "node:crypto"
import { handleRequest, API_VERSION } from "./router"
import { FixedWindowRateLimiter, identifyCaller } from "./rateLimit"
import { QuorvelCloudService, type ServiceDeps } from "./service"
import type { Store } from "./store"

export interface ServerOptions {
    adminSecret?: string
    dashboardSecret?: string
    deps?: ServiceDeps
}

export function buildServer(store: Store, opts: ServerOptions = {}) {
    const app = Fastify({
        logger: {
            level: process.env.LOG_LEVEL ?? "info",
            redact: [
                "req.headers.authorization",
                "req.headers['x-dashboard-secret']",
                "req.headers['x-admin-secret']",
                "req.headers['paddle-signature']",
            ],
        },
        trustProxy: true,
        genReqId: (req) => {
            const rid = req.headers["x-request-id"]
            return (typeof rid === "string" && rid) || randomUUID()
        },
    })

    // Capture the raw JSON body so webhook signatures can be verified.
    app.addContentTypeParser(
        "application/json",
        { parseAs: "string" },
        (req: any, body: any, done: any) => {
            ;(req as any).rawBody = body
            if (!body) return done(null, undefined)
            try {
                done(null, JSON.parse(body as string))
            } catch (err) {
                done(err as Error, undefined)
            }
        },
    )

    // --- Security headers + CORS (no external deps) ---
    // Origin allowlist is env-driven (comma-separated); defaults to the prod
    // dashboard. Non-browser callers (SDK/curl) send no Origin -> unaffected.
    const corsOrigins = (process.env.QUORVEL_CORS_ORIGINS ?? "https://app.quorvel.tech")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean)
    const allowedHeaders =
        "authorization,content-type,idempotency-key,x-dashboard-secret,x-clerk-org-id,x-clerk-user-id,x-clerk-org-name"

    app.addHook("onRequest", async (req: any, reply: any) => {
        reply.header("x-content-type-options", "nosniff")
        reply.header("x-frame-options", "DENY")
        reply.header("referrer-policy", "no-referrer")
        reply.header("x-dns-prefetch-control", "off")
        reply.header("strict-transport-security", "max-age=15552000; includeSubDomains")
        reply.header("x-request-id", req.id)

        const origin = req.headers?.["origin"] as string | undefined
        if (origin && corsOrigins.includes(origin)) {
            reply.header("access-control-allow-origin", origin)
            reply.header("vary", "Origin")
            reply.header("access-control-allow-methods", "GET,POST,DELETE,OPTIONS")
            reply.header("access-control-allow-headers", allowedHeaders)
            reply.header("access-control-max-age", "600")
        }

        if (req.method === "OPTIONS") {
            reply.code(204)
            return reply.send()
        }
    })
    const svc = new QuorvelCloudService(store, opts.deps)
    const adminSecret = opts.adminSecret ?? process.env.QUORVEL_ADMIN_SECRET
    const dashboardSecret = opts.dashboardSecret ?? process.env.DASHBOARD_SERVICE_SECRET

    // Per-caller rate limiting (cost guardrail). Authenticated callers are capped
    // per API key / org; unauthenticated callers share a separate, tighter IP cap.
    // Both default OFF (limit 0) so prod is unaffected until you opt in.
    const rlMax = Number(process.env.QUORVEL_RATE_LIMIT_PER_MIN ?? 0)
    const rlAnonMax = Number(process.env.QUORVEL_RATE_LIMIT_ANON_PER_MIN ?? rlMax)
    const authedLimiter = rlMax > 0 ? new FixedWindowRateLimiter(rlMax) : undefined
    const anonLimiter = rlAnonMax > 0 ? new FixedWindowRateLimiter(rlAnonMax) : undefined

    if (authedLimiter || anonLimiter) {
        // Periodically drop expired buckets so memory can't grow unbounded.
        const live = [authedLimiter, anonLimiter].filter(Boolean) as FixedWindowRateLimiter[]
        const sweepTimer = setInterval(() => {
            for (const l of live) l.sweep()
        }, 60_000)
        if (typeof (sweepTimer as any).unref === "function") (sweepTimer as any).unref()
        app.addHook("onClose", async () => clearInterval(sweepTimer))

        app.addHook("onRequest", async (req: any, reply: any) => {
            const url: string = req.url ?? "/"
            if (!url.startsWith("/v1/")) return
            // Webhooks are signature-verified and must never be dropped.
            if (url.startsWith("/v1/webhooks/")) return

            const caller = identifyCaller({
                authorization: req.headers?.["authorization"],
                orgId: req.headers?.["x-clerk-org-id"],
                ip: req.ip,
            })
            const limiter = caller.authenticated ? authedLimiter : anonLimiter
            if (!limiter) return

            const r = limiter.check(caller.id)
            reply.header("x-ratelimit-limit", String(r.limit))
            reply.header("x-ratelimit-remaining", String(r.remaining))
            reply.header("x-ratelimit-reset", String(Math.ceil(r.resetMs / 1000)))
            if (!r.allowed) {
                reply.header("x-api-version", API_VERSION)
                reply.header("retry-after", String(Math.ceil(r.resetMs / 1000)))
                reply.code(429)
                return reply.send({ error: "rate limit exceeded", code: "rate_limited" })
            }
        })
    }

    app.all("/*", async (req: any, reply: any) => {
        const url: string = req.url ?? "/"
        const path = url.split("?")[0]
        const res = await handleRequest(svc, adminSecret, {
            method: req.method,
            path,
            query: req.query ?? {},
            body: req.body,
            headers: req.headers ?? {},
            rawBody: (req as any).rawBody,
        }, dashboardSecret)
        reply.header("x-api-version", API_VERSION)
        reply.code(res.status)
        return res.body ?? null
    })

    return app
}