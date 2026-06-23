// Part 9 — metered billing: plan limits, usage accrual, quota enforcement at
// insert time, and Stripe reporting (over fake fetch).
import { assert, it, section, summary } from "./_assert"
import {
	MemUsageStore,
	StripeMeter,
	UsageMeter,
	currentPeriod,
	planLimit,
	type FetchLike,
} from "../src/billing"
import type { FetchResponse } from "../src/alerts"
import { InProcessBus } from "../src/bus"
import { ApiError, QuorvelCloudService } from "../src/service"
import { MemStore } from "../src/store"
import type { DomainEvent } from "../src/events"

const plans = (plan: string) => async () => plan

console.log("belay-cloud-api billing tests")

await (async () => {
	section("plans + usage store")

	await it("planLimit resolves known plans and defaults to free", () => {
		assert.equal(planLimit("free"), 1000)
		assert.equal(planLimit("pro"), 100000)
		assert.equal(planLimit("nonsense"), 1000)
	})

	await it("currentPeriod is YYYY-MM", () => {
		assert.match(currentPeriod(new Date("2026-06-20T00:00:00Z")), /^2026-06$/)
	})

	await it("MemUsageStore increments and reads back", async () => {
		const u = new MemUsageStore()
		assert.equal(await u.increment("o", "2026-06", 1), 1)
		assert.equal(await u.increment("o", "2026-06", 2), 3)
		assert.equal(await u.get("o", "2026-06"), 3)
		assert.equal(await u.get("o", "2026-07"), 0)
	})

	section("UsageMeter")

	await it("check allows under limit and denies at/over limit", async () => {
		const u = new MemUsageStore()
		const meter = new UsageMeter(u, plans("free"))
		assert.equal((await meter.check("o")).allowed, true)
		await u.increment("o", currentPeriod(), 1000)
		const denied = await meter.check("o")
		assert.equal(denied.allowed, false)
		assert.match(denied.reason!, /quota/)
	})

	await it("usage snapshot reports plan/used/limit/remaining", async () => {
		const u = new MemUsageStore()
		await u.increment("o", currentPeriod(), 10)
		const snap = await new UsageMeter(u, plans("pro")).usage("o")
		assert.equal(snap.plan, "pro")
		assert.equal(snap.used, 10)
		assert.equal(snap.limit, 100000)
		assert.equal(snap.remaining, 99990)
	})

	await it("onEvent counts action.created and ignores transitions", async () => {
		const u = new MemUsageStore()
		const meter = new UsageMeter(u, plans("free"))
		const mk = (type: DomainEvent["type"]): DomainEvent => ({ type, orgId: "o", idempotencyKey: "k", tool: "t", scope: null, cost: 0, status: "pending", at: "" })
		await meter.onEvent(mk("action.created"))
		await meter.onEvent(mk("action.transition"))
		assert.equal(await u.get("o", currentPeriod()), 1)
	})

	section("StripeMeter")

	await it("reports usage with form-encoded body + bearer auth", async () => {
		let captured: { url: string; headers?: Record<string, string>; body?: string } | undefined
		const fetch: FetchLike = async (url, init) => {
			captured = { url, headers: init?.headers, body: init?.body }
			const res: FetchResponse = { ok: true, status: 200, text: async () => "" }
			return res
		}
		await new StripeMeter({ secretKey: "sk_test_1" }, fetch).report("org_42", 1)
		assert.match(captured!.url, /api\.stripe\.com/)
		assert.equal(captured!.headers!["authorization"], "Bearer sk_test_1")
		assert.match(captured!.body!, /stripe_customer_id/)
		assert.match(captured!.body!, /org_42/)
	})

	section("service integration")

	await it("insertPending rejects with 402 when the limiter denies", async () => {
		const u = new MemUsageStore()
		await u.increment("o", currentPeriod(), 1000) // hit free cap
		const meter = new UsageMeter(u, plans("free"))
		const svc = new QuorvelCloudService(new MemStore(), { limiter: meter })
		await assert.rejects(
			() => svc.insertPending("o", { idempotencyKey: "k", scope: null, tool: "t" }),
			(e: unknown) => e instanceof ApiError && e.statusCode === 402,
		)
	})

	await it("meter + bus: creating actions accrues usage and reports to Stripe", async () => {
		const u = new MemUsageStore()
		let reported = 0
		const reporter = { report: async () => { reported++ } }
		const meter = new UsageMeter(u, plans("free"), reporter)
		const bus = new InProcessBus([meter.onEvent])
		const svc = new QuorvelCloudService(new MemStore(), { bus, limiter: meter })
		await svc.insertPending("o", { idempotencyKey: "a", scope: null, tool: "t" })
		await svc.insertPending("o", { idempotencyKey: "b", scope: null, tool: "t" })
		assert.equal(await u.get("o", currentPeriod()), 2)
		assert.equal(reported, 2)
		const snap = await svc.usage("o")
		assert.equal(snap.used, 2)
	})

	summary()
})()
