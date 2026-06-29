// Circuit breaker state machine + graceful-degradation error + guard() proxy.
// Clock is injected, so every timing case is deterministic (no setTimeout).
import { assert, it, section, summary } from "./_assert"
import { ApiError } from "../src/service"
import {
    CircuitBreaker,
    DependencyUnavailableError,
    guard,
} from "../src/resilience"

const ok = async () => "ok"
const boom = async () => {
    throw new Error("boom")
}
const zero = () => 0

console.log("belay-cloud-api resilience tests")
void (async () => {
    section("CircuitBreaker: closed/open")

    await it("starts closed and passes successful calls through", async () => {
        const cb = new CircuitBreaker({ name: "db", now: zero })
        assert.equal(await cb.exec(ok), "ok")
        assert.equal(cb.getState(), "closed")
    })

    await it("opens after failureThreshold consecutive failures", async () => {
        const cb = new CircuitBreaker({ name: "db", failureThreshold: 3, now: zero })
        for (let i = 0; i < 3; i++) {
            try { await cb.exec(boom) } catch { /* expected */ }
        }
        assert.equal(cb.getState(), "open")
    })

    await it("fast-fails while open WITHOUT invoking the wrapped fn", async () => {
        const cb = new CircuitBreaker({ name: "paddle", failureThreshold: 1, cooldownMs: 1000, now: zero })
        try { await cb.exec(boom) } catch { /* opens */ }
        assert.equal(cb.getState(), "open")
        let called = false
        let err: any
        try {
            await cb.exec(async () => { called = true; return "x" })
        } catch (e) { err = e }
        assert.equal(called, false)
        assert.ok(err instanceof DependencyUnavailableError)
        assert.equal(err.dependency, "paddle")
    })

    await it("a success resets the consecutive-failure count", async () => {
        const cb = new CircuitBreaker({ name: "db", failureThreshold: 3, now: zero })
        try { await cb.exec(boom) } catch {}
        try { await cb.exec(boom) } catch {}
        await cb.exec(ok) // reset
        try { await cb.exec(boom) } catch {}
        try { await cb.exec(boom) } catch {}
        assert.equal(cb.getState(), "closed") // only 2 consecutive since the reset
    })

    section("CircuitBreaker: half-open recovery")

    await it("after cooldown goes half-open and a successful trial closes it", async () => {
        let t = 0
        const cb = new CircuitBreaker({ name: "db", failureThreshold: 1, cooldownMs: 1000, now: () => t })
        try { await cb.exec(boom) } catch {} // open at t=0
        t = 999
        let blocked = false
        try { await cb.exec(ok) } catch { blocked = true }
        assert.ok(blocked) // still open just before cooldown elapses
        t = 1000
        assert.equal(await cb.exec(ok), "ok") // half-open trial succeeds -> closed
        assert.equal(cb.getState(), "closed")
    })

    await it("a failed half-open trial re-opens immediately", async () => {
        let t = 0
        const cb = new CircuitBreaker({ name: "db", failureThreshold: 1, cooldownMs: 1000, now: () => t })
        try { await cb.exec(boom) } catch {} // open
        t = 1000
        try { await cb.exec(boom) } catch {} // half-open trial fails
        assert.equal(cb.getState(), "open")
    })

    await it("successThreshold > 1 requires multiple trials to close", async () => {
        let t = 0
        const cb = new CircuitBreaker({ name: "db", failureThreshold: 1, cooldownMs: 100, successThreshold: 2, now: () => t })
        try { await cb.exec(boom) } catch {} // open
        t = 100
        await cb.exec(ok) // trial 1
        assert.equal(cb.getState(), "half_open")
        await cb.exec(ok) // trial 2 -> closed
        assert.equal(cb.getState(), "closed")
    })

    section("graceful degradation error")

    await it("reports a positive retryAfterSeconds when open", async () => {
        let t = 0
        const cb = new CircuitBreaker({ name: "paddle", failureThreshold: 1, cooldownMs: 30000, now: () => t })
        try { await cb.exec(boom) } catch {}
        let err: any
        try { await cb.exec(ok) } catch (e) { err = e }
        assert.ok(err.retryAfterSeconds >= 1 && err.retryAfterSeconds <= 30)
    })

    await it("emits state transitions via onStateChange", async () => {
        let t = 0
        const states: string[] = []
        const cb = new CircuitBreaker({
            name: "db", failureThreshold: 1, cooldownMs: 100, now: () => t,
            onStateChange: (s) => states.push(s),
        })
        try { await cb.exec(boom) } catch {} // -> open
        t = 100
        await cb.exec(ok) // -> half_open -> closed
        assert.deepEqual(states, ["open", "half_open", "closed"])
    })

    await it("DependencyUnavailableError is an ApiError 503 service_unavailable", async () => {
        const e = new DependencyUnavailableError("billing", 12)
        assert.ok(e instanceof ApiError)
        assert.equal(e.statusCode, 503)
        assert.equal(e.code, "service_unavailable")
        assert.equal(e.dependency, "billing")
        assert.equal(e.retryAfterSeconds, 12)
    })

    section("guard() proxy")

    await it("routes methods through the breaker and fast-fails when open", async () => {
        let calls = 0
        const dep = {
            ping: async () => { calls++; return "pong" },
            fail: async () => { throw new Error("x") },
        }
        const cb = new CircuitBreaker({ name: "db", failureThreshold: 1, cooldownMs: 1000, now: zero })
        const g = guard(dep, cb)
        assert.equal(await g.ping(), "pong")
        assert.equal(calls, 1)
        try { await g.fail() } catch {} // opens
        let blocked = false
        try { await g.ping() } catch (e) { blocked = e instanceof DependencyUnavailableError }
        assert.ok(blocked)
        assert.equal(calls, 1) // underlying ping was NOT called again
    })

    await it("passes non-function properties through untouched", async () => {
        const dep = { label: "db-store", greet: async () => "hi" }
        const cb = new CircuitBreaker({ name: "db", now: zero })
        const g = guard(dep, cb)
        assert.equal(g.label, "db-store")
        assert.equal(await g.greet(), "hi")
    })

    await it("leaves skipped methods unwrapped (they bypass the breaker)", async () => {
        let webhookCalls = 0
        const dep = {
            charge: async () => { throw new Error("down") },
            handleWebhook: async () => { webhookCalls++; return "verified" },
        }
        const cb = new CircuitBreaker({ name: "paddle", failureThreshold: 1, cooldownMs: 1000, now: zero })
        const g = guard(dep, cb, { skip: ["handleWebhook"] })
        try { await g.charge() } catch {} // opens the breaker
        assert.equal(cb.getState(), "open")
        assert.equal(await g.handleWebhook(), "verified") // still works while open
        assert.equal(webhookCalls, 1)
    })

    summary()
})()