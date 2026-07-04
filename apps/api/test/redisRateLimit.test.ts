// Redis-backed rate limiter: same fixed-window semantics as the in-memory
// limiter, but the counter lives in Redis so the cap is shared across every
// API instance. Exercised against an in-process fake client (CI has no Redis).
import { assert, it, section, summary } from "./_assert"
import {
    RedisRateLimiter,
    FixedWindowRateLimiter,
    createRateLimiter,
    type RedisLike,
} from "../src/rateLimit"

// In-process stand-in mirroring the Lua INCR + PEXPIRE + PTTL fixed-window
// counter. A manual clock lets us assert window resets deterministically.
class FakeRedis implements RedisLike {
    now = 0
    readonly calls: string[] = []
    private store = new Map<string, { count: number; expireAt: number }>()
    async eval(
        _script: string,
        _numKeys: number,
        ...args: Array<string | number>
    ): Promise<[number, number]> {
        const key = String(args[0])
        const windowMs = Number(args[1])
        this.calls.push(key)
        let e = this.store.get(key)
        if (!e || this.now >= e.expireAt) {
            e = { count: 0, expireAt: this.now + windowMs }
            this.store.set(key, e)
        }
        e.count++
        return [e.count, Math.max(0, e.expireAt - this.now)]
    }
}

console.log("belay-cloud-api redis rate-limit tests")
void (async () => {
    section("RedisRateLimiter")

    await it("allows up to max then blocks within the window", async () => {
        const rl = new RedisRateLimiter(2, 1000, { client: new FakeRedis() })
        assert.equal((await rl.check("k")).allowed, true)
        assert.equal((await rl.check("k")).allowed, true)
        const third = await rl.check("k")
        assert.equal(third.allowed, false)
        assert.equal(third.remaining, 0)
        assert.equal(third.limit, 2)
    })

    await it("resets after the window elapses", async () => {
        const redis = new FakeRedis()
        const rl = new RedisRateLimiter(1, 1000, { client: redis })
        assert.equal((await rl.check("k")).allowed, true)
        assert.equal((await rl.check("k")).allowed, false)
        redis.now = 1000
        assert.equal((await rl.check("k")).allowed, true)
    })

    await it("buckets are isolated per key", async () => {
        const rl = new RedisRateLimiter(1, 1000, { client: new FakeRedis() })
        assert.equal((await rl.check("a")).allowed, true)
        assert.equal((await rl.check("a")).allowed, false)
        assert.equal((await rl.check("b")).allowed, true)
    })

    await it("namespaces keys under rl: in Redis", async () => {
        const redis = new FakeRedis()
        const rl = new RedisRateLimiter(5, 1000, { client: redis })
        await rl.check("org:x")
        assert.ok(redis.calls.includes("rl:org:x"))
    })

    await it("reports remaining, limit, and a positive resetMs", async () => {
        const rl = new RedisRateLimiter(3, 1000, { client: new FakeRedis() })
        const r = await rl.check("k")
        assert.equal(r.remaining, 2)
        assert.equal(r.limit, 3)
        assert.ok(r.resetMs > 0 && r.resetMs <= 1000)
    })

    section("createRateLimiter")

    await it("returns a Redis limiter when a client is provided", async () => {
        const rl = createRateLimiter(2, { client: new FakeRedis() })
        assert.ok(rl instanceof RedisRateLimiter)
        assert.equal((await rl.check("k")).allowed, true)
    })

    await it("falls back to the in-memory limiter without Redis", () => {
        const rl = createRateLimiter(2)
        assert.ok(rl instanceof FixedWindowRateLimiter)
    })

    summary()
})()