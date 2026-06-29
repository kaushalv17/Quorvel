// Thin Fastify adapter. It only translates HTTP <-> RawRequest/RawResponse and
// delegates ALL logic to handleRequest (router.ts), so what we unit-test is what
// serves traffic.
import Fastify from "fastify"
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
    const app = Fastify({ logger: false })

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