// Per-caller rate limiting + cost guardrail.
//   - over-limit => 429 with Retry-After + code "rate_limited"
//   - key isolation: a noisy key does NOT throttle a different key
//   - unauthenticated callers are capped on a separate IP bucket
//   - /v1/webhooks/* is exempt (signature-verified, never dropped)
import { assert, it, section, summary } from "./_assert"
import { FixedWindowRateLimiter, identifyCaller } from "../src/rateLimit"
import { buildServer } from "../src/server"
import { MemStore } from "../src/store"
import { QuorvelCloudService } from "../src/service"

const RL = "QUORVEL_RATE_LIMIT_PER_MIN"
const RL_ANON = "QUORVEL_RATE_LIMIT_ANON_PER_MIN"

async function freshServer(env: Record<string, string>) {
    process.env[RL] = "0"
    process.env[RL_ANON] = "0"
    for (const [k, v] of Object.entries(env)) process.env[k] = v
    const store = new MemStore()
    const svc = new QuorvelCloudService(store)
    const app = buildServer(store)
    await app.ready()
    return { app, svc }
}

console.log("belay-cloud-api rate-limit tests")
void (async () => {
    section("FixedWindowRateLimiter")

    await it("allows up to max, blocks the next, resets after the window", () => {
        const rl = new FixedWindowRateLimiter(2, 1000)
        const t0 = 1000
        assert.equal(rl.check("k", t0).allowed, true)
        assert.equal(rl.check("k", t0).allowed, true)
        const third = rl.check("k", t0)
        assert.equal(third.allowed, false)
        assert.equal(third.remaining, 0)
        assert.equal(rl.check("k", t0 + 1000).allowed, true)
    })

    await it("buckets are isolated per key", () => {
        const rl = new FixedWindowRateLimiter(1, 1000)
        assert.equal(rl.check("a", 0).allowed, true)
        assert.equal(rl.check("a", 0).allowed, false)
        assert.equal(rl.check("b", 0).allowed, true)
    })

    await it("sweep drops only expired buckets", () => {
        const rl = new FixedWindowRateLimiter(5, 1000)
        rl.check("old", 0)
        rl.check("new", 900)
        rl.sweep(1000)
        assert.equal(rl.size, 1)
    })

    section("identifyCaller")

    await it("buckets by hashed bearer token without leaking the secret", () => {
        const a = identifyCaller({ authorization: "Bearer qrv_live_secret123" })
        assert.equal(a.authenticated, true)
        assert.ok(a.id.startsWith("key:"))
        assert.ok(!a.id.includes("secret123"))
        const a2 = identifyCaller({ authorization: "Bearer qrv_live_secret123" })
        assert.equal(a.id, a2.id)
        const b = identifyCaller({ authorization: "Bearer qrv_live_other" })
        assert.notEqual(a.id, b.id)
    })

    await it("falls back to org then IP; IP-only callers are unauthenticated", () => {
        const org = identifyCaller({ orgId: "org_123" })
        assert.equal(org.authenticated, true)
        assert.equal(org.id, "org:org_123")
        const ip = identifyCaller({ ip: "1.2.3.4" })
        assert.equal(ip.authenticated, false)
        assert.equal(ip.id, "ip:1.2.3.4")
    })

    section("server (per-key HTTP rate limiting)")

    await it("429 + Retry-After once a key exceeds its per-minute cap", async () => {
        const { app, svc } = await freshServer({ [RL]: "2" })
        const { apiKey } = await svc.issueApiKey({})
        const headers = { authorization: `Bearer ${apiKey}` }
        try {
            const r1 = await app.inject({ method: "GET", url: "/v1/usage", headers })
            const r2 = await app.inject({ method: "GET", url: "/v1/usage", headers })
            const r3 = await app.inject({ method: "GET", url: "/v1/usage", headers })
            assert.notEqual(r1.statusCode, 429)
            assert.notEqual(r2.statusCode, 429)
            assert.equal(r3.statusCode, 429)
            assert.equal(JSON.parse(r3.body).code, "rate_limited")
            assert.ok(r3.headers["retry-after"])
            assert.equal(r3.headers["x-api-version"], "1")
        } finally {
            await app.close()
        }
    })

    await it("a noisy key does not throttle a different key", async () => {
        const { app, svc } = await freshServer({ [RL]: "1" })
        const { apiKey: keyA } = await svc.issueApiKey({})
        const { apiKey: keyB } = await svc.issueApiKey({})
        try {
            const a1 = await app.inject({ method: "GET", url: "/v1/usage", headers: { authorization: `Bearer ${keyA}` } })
            const a2 = await app.inject({ method: "GET", url: "/v1/usage", headers: { authorization: `Bearer ${keyA}` } })
            const b1 = await app.inject({ method: "GET", url: "/v1/usage", headers: { authorization: `Bearer ${keyB}` } })
            assert.notEqual(a1.statusCode, 429)
            assert.equal(a2.statusCode, 429)
            assert.notEqual(b1.statusCode, 429)
        } finally {
            await app.close()
        }
    })

    await it("unauthenticated callers are capped on the anon IP bucket", async () => {
        const { app } = await freshServer({ [RL_ANON]: "1" })
        try {
            const r1 = await app.inject({ method: "GET", url: "/v1/usage" })
            const r2 = await app.inject({ method: "GET", url: "/v1/usage" })
            assert.notEqual(r1.statusCode, 429)
            assert.equal(r2.statusCode, 429)
        } finally {
            await app.close()
        }
    })

    await it("never rate-limits webhook delivery, even at anon cap 1", async () => {
        const { app } = await freshServer({ [RL_ANON]: "1" })
        try {
            const r1 = await app.inject({ method: "POST", url: "/v1/webhooks/paddle", payload: {}, headers: { "content-type": "application/json" } })
            const r2 = await app.inject({ method: "POST", url: "/v1/webhooks/paddle", payload: {}, headers: { "content-type": "application/json" } })
            const r3 = await app.inject({ method: "POST", url: "/v1/webhooks/paddle", payload: {}, headers: { "content-type": "application/json" } })
            assert.notEqual(r1.statusCode, 429)
            assert.notEqual(r2.statusCode, 429)
            assert.notEqual(r3.statusCode, 429)
        } finally {
            await app.close()
        }
    })

    summary()
})()