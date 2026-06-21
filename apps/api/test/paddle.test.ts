// apps/api/src/tests/paddle.test.ts
// Self-contained (node:assert) so it runs standalone via `tsx`.
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import {
	PaddleBilling,
	resolvePlan,
	verifyPaddleSignature,
	orgIdFromEvent,
	priceIdFromEvent,
	type FetchLike,
	type PlanStore,
} from "../src/paddle"

const PRO = "pri_pro_123"
const SCALE = "pri_scale_456"
const SECRET = "pdl_ntfset_secret_abc"
const priceToPlan: Record<string, string> = { [PRO]: "pro", [SCALE]: "scale" }

function sign(secret: string, body: string, ts = String(Math.floor(Date.now() / 1000))): string {
	const h1 = createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex")
	return `ts=${ts};h1=${h1}`
}

class FakeStore implements PlanStore {
	calls: Array<[string, string]> = []
	async setOrgPlan(orgId: string, plan: string): Promise<void> {
		this.calls.push([orgId, plan])
	}
}

function subEvent(opts: {
	type?: string
	orgId?: string | null
	priceId?: string
	status?: string
}): any {
	const data: any = { status: opts.status ?? "active" }
	if (opts.orgId !== null) data.custom_data = { org_id: opts.orgId ?? "org_1" }
	if (opts.priceId) data.items = [{ price: { id: opts.priceId } }]
	return { event_type: opts.type ?? "subscription.created", data }
}

const tests: Array<[string, () => void | Promise<void>]> = []
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn])

// --- signature ---
test("valid signature passes", () => {
	const body = `{"a":1}`
	assert.equal(verifyPaddleSignature(body, sign(SECRET, body), SECRET), true)
})
test("tampered body fails", () => {
	const header = sign(SECRET, `{"a":1}`)
	assert.equal(verifyPaddleSignature(`{"a":2}`, header, SECRET), false)
})
test("wrong secret fails", () => {
	const body = `{"a":1}`
	assert.equal(verifyPaddleSignature(body, sign("other", body), SECRET), false)
})
test("missing/garbage header fails", () => {
	assert.equal(verifyPaddleSignature(`{}`, undefined, SECRET), false)
	assert.equal(verifyPaddleSignature(`{}`, "nope", SECRET), false)
})
test("stale timestamp fails when tolerance set", () => {
	const body = `{"a":1}`
	const header = sign(SECRET, body, "1000000000") // year 2001
	assert.equal(
		verifyPaddleSignature(body, header, SECRET, { toleranceSeconds: 300 }),
		false,
	)
})

// --- helpers ---
test("orgIdFromEvent extracts org_id", () => {
	assert.equal(orgIdFromEvent(subEvent({ orgId: "org_42" })), "org_42")
	assert.equal(orgIdFromEvent(subEvent({ orgId: null })), undefined)
})
test("priceIdFromEvent extracts (price.id and price_id fallback)", () => {
	assert.equal(priceIdFromEvent({ data: { items: [{ price: { id: PRO } }] } }), PRO)
	assert.equal(priceIdFromEvent({ data: { items: [{ price_id: SCALE }] } }), SCALE)
	assert.equal(priceIdFromEvent({ data: {} }), undefined)
})

// --- resolvePlan ---
test("resolvePlan maps pro price", () => {
	assert.equal(resolvePlan(subEvent({ priceId: PRO }), priceToPlan), "pro")
})
test("resolvePlan maps scale price", () => {
	assert.equal(resolvePlan(subEvent({ priceId: SCALE }), priceToPlan), "scale")
})
test("resolvePlan canceled event -> free", () => {
	assert.equal(
		resolvePlan(subEvent({ type: "subscription.canceled", priceId: PRO }), priceToPlan),
		"free",
	)
})
test("resolvePlan canceled/paused status -> free", () => {
	assert.equal(resolvePlan(subEvent({ status: "canceled", priceId: PRO }), priceToPlan), "free")
	assert.equal(resolvePlan(subEvent({ status: "paused", priceId: PRO }), priceToPlan), "free")
})
test("resolvePlan unknown price -> undefined", () => {
	assert.equal(resolvePlan(subEvent({ priceId: "pri_unknown" }), priceToPlan), undefined)
})
test("resolvePlan non-subscription event -> undefined", () => {
	assert.equal(
		resolvePlan({ event_type: "transaction.completed", data: { items: [{ price: { id: PRO } }] } }, priceToPlan),
		undefined,
	)
})

// --- handleWebhook ---
test("handleWebhook flips plan on valid signed event", async () => {
	const billing = new PaddleBilling({ apiKey: "k", webhookSecret: SECRET, priceToPlan })
	const store = new FakeStore()
	const body = JSON.stringify(subEvent({ orgId: "org_9", priceId: SCALE }))
	const res = await billing.handleWebhook(body, sign(SECRET, body), store)
	assert.deepEqual(res, { handled: true, eventType: "subscription.created", orgId: "org_9", plan: "scale" })
	assert.deepEqual(store.calls, [["org_9", "scale"]])
})
test("handleWebhook throws on bad signature", async () => {
	const billing = new PaddleBilling({ apiKey: "k", webhookSecret: SECRET, priceToPlan })
	const store = new FakeStore()
	const body = JSON.stringify(subEvent({ orgId: "org_9", priceId: SCALE }))
	await assert.rejects(() => billing.handleWebhook(body, sign("wrong", body), store), /invalid paddle signature/)
	assert.deepEqual(store.calls, [])
})
test("handleWebhook ack-without-action when org_id missing", async () => {
	const billing = new PaddleBilling({ apiKey: "k", webhookSecret: SECRET, priceToPlan })
	const store = new FakeStore()
	const body = JSON.stringify(subEvent({ orgId: null, priceId: PRO }))
	const res = await billing.handleWebhook(body, sign(SECRET, body), store)
	assert.equal(res.handled, false)
	assert.deepEqual(store.calls, [])
})
test("handleWebhook canceled -> free", async () => {
	const billing = new PaddleBilling({ apiKey: "k", webhookSecret: SECRET, priceToPlan })
	const store = new FakeStore()
	const body = JSON.stringify(subEvent({ type: "subscription.canceled", orgId: "org_3" }))
	const res = await billing.handleWebhook(body, sign(SECRET, body), store)
	assert.equal(res.plan, "free")
	assert.deepEqual(store.calls, [["org_3", "free"]])
})

// --- createCheckout ---
test("createCheckout posts transaction with org_id custom_data", async () => {
	let captured: any = null
	const mockFetch: FetchLike = async (url, init) => {
		captured = { url, init }
		return {
			ok: true,
			status: 200,
			json: async () => ({ data: { id: "txn_1", checkout: { url: "https://pay.paddle.com/x" } } }),
			text: async () => "",
		}
	}
	const billing = new PaddleBilling({
		apiKey: "sk_test",
		webhookSecret: SECRET,
		priceToPlan,
		apiBase: "https://sandbox-api.paddle.com",
		fetchImpl: mockFetch,
	})
	const out = await billing.createCheckout("org_77", "pro")
	assert.equal(out.transactionId, "txn_1")
	assert.equal(out.checkoutUrl, "https://pay.paddle.com/x")
	assert.equal(out.priceId, PRO)
	assert.equal(captured.url, "https://sandbox-api.paddle.com/transactions")
	assert.equal(captured.init.headers.authorization, "Bearer sk_test")
	const sent = JSON.parse(captured.init.body)
	assert.equal(sent.items[0].price_id, PRO)
	assert.equal(sent.custom_data.org_id, "org_77")
})
test("createCheckout throws for unknown plan", async () => {
	const billing = new PaddleBilling({ apiKey: "k", webhookSecret: SECRET, priceToPlan })
	await assert.rejects(() => billing.createCheckout("org_1", "enterprise"), /no Paddle price configured/)
})
test("createCheckout surfaces API errors", async () => {
	const mockFetch: FetchLike = async () => ({
		ok: false,
		status: 403,
		json: async () => ({}),
		text: async () => "forbidden",
	})
	const billing = new PaddleBilling({ apiKey: "k", webhookSecret: SECRET, priceToPlan, fetchImpl: mockFetch })
	await assert.rejects(() => billing.createCheckout("org_1", "pro"), /403 forbidden/)
})
test("priceForPlan reverse lookup", () => {
	const billing = new PaddleBilling({ apiKey: "k", webhookSecret: SECRET, priceToPlan })
	assert.equal(billing.priceForPlan("pro"), PRO)
	assert.equal(billing.priceForPlan("scale"), SCALE)
	assert.equal(billing.priceForPlan("free"), undefined)
})

async function run() {
	let passed = 0
	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			passed++
			console.log(`ok   - ${name}`)
		} catch (e) {
			failed++
			console.error(`FAIL - ${name}\n       ${e instanceof Error ? e.message : e}`)
		}
	}
	console.log(`\n${passed}/${passed + failed} passed`)
	if (failed) process.exit(1)
}
run()
