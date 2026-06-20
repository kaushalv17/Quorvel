// Contract tests for the dashboard's BelayClient. A fake fetch records every
// request and returns canned responses, so we verify URLs, methods, auth
// headers, bodies, and response/error parsing with zero network and zero deps.
import { assert, it, section, summary } from "./_assert"
import { BelayApiError, BelayClient, groupByScope, type ActionRecord, type FetchInit, type FetchResponse } from "../lib/belay"

interface Recorded {
	url: string
	init?: FetchInit
}

function fakeFetch(handler: (rec: Recorded) => { status: number; body?: unknown }) {
	const calls: Recorded[] = []
	const fetchImpl = async (url: string, init?: FetchInit): Promise<FetchResponse> => {
		const rec = { url, init }
		calls.push(rec)
		const { status, body } = handler(rec)
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => body,
			text: async () => JSON.stringify(body ?? ""),
		}
	}
	return { fetchImpl, calls }
}

const action = (over: Partial<ActionRecord> = {}): ActionRecord => ({
	idempotencyKey: "k1",
	scope: "agent-a",
	tool: "refund",
	args: null,
	cost: 1,
	status: "awaiting_approval",
	attempts: 0,
	createdAt: "2026-01-01T00:00:00.000Z",
	...over,
})

console.log("belay-dashboard lib tests")

void (async () => {
	section("BelayClient")

	await it("sends Bearer auth + JSON content-type and strips trailing slash", async () => {
		const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: [] }))
		const client = new BelayClient({ baseUrl: "https://api.example.com/", apiKey: "bly_live_x", fetchImpl })
		await client.listRecent()
		assert.equal(calls[0].url, "https://api.example.com/v1/actions?limit=50")
		assert.equal(calls[0].init?.headers?.["authorization"], "Bearer bly_live_x")
		assert.equal(calls[0].init?.headers?.["content-type"], "application/json")
	})

	await it("approvalQueue requests awaiting_approval status", async () => {
		const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: [action()] }))
		const client = new BelayClient({ baseUrl: "https://api.example.com", apiKey: "k", fetchImpl })
		const rows = await client.approvalQueue()
		assert.match(calls[0].url, /status=awaiting_approval/)
		assert.equal(rows.length, 1)
		assert.equal(rows[0].tool, "refund")
	})

	await it("approve POSTs to /approved and tolerates 204", async () => {
		const { fetchImpl, calls } = fakeFetch(() => ({ status: 204 }))
		const client = new BelayClient({ baseUrl: "https://api.example.com", apiKey: "k", fetchImpl })
		await client.approve("k1")
		assert.equal(calls[0].url, "https://api.example.com/v1/actions/k1/approved")
		assert.equal(calls[0].init?.method, "POST")
	})

	await it("reject POSTs the reason body", async () => {
		const { fetchImpl, calls } = fakeFetch(() => ({ status: 204 }))
		const client = new BelayClient({ baseUrl: "https://api.example.com", apiKey: "k", fetchImpl })
		await client.reject("k1", "too risky")
		assert.match(calls[0].url, /\/v1\/actions\/k1\/rejected$/)
		assert.deepEqual(JSON.parse(calls[0].init!.body!), { reason: "too risky" })
	})

	await it("encodes action keys in the path", async () => {
		const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: action() }))
		const client = new BelayClient({ baseUrl: "https://api.example.com", apiKey: "k", fetchImpl })
		await client.getAction("a/b c")
		assert.equal(calls[0].url, "https://api.example.com/v1/actions/a%2Fb%20c")
	})

	await it("usage parses the snapshot", async () => {
		const snap = { plan: "pro", period: "2026-01", used: 10, limit: 100000, remaining: 99990 }
		const { fetchImpl } = fakeFetch(() => ({ status: 200, body: snap }))
		const client = new BelayClient({ baseUrl: "https://api.example.com", apiKey: "k", fetchImpl })
		assert.deepEqual(await client.usage(), snap)
	})

	await it("throws BelayApiError with code on non-2xx", async () => {
		const { fetchImpl } = fakeFetch(() => ({ status: 402, body: { error: "quota exceeded", code: "quota_exceeded" } }))
		const client = new BelayClient({ baseUrl: "https://api.example.com", apiKey: "k", fetchImpl })
		await assert.rejects(
			() => client.listRecent(),
			(e: unknown) => e instanceof BelayApiError && e.status === 402 && e.code === "quota_exceeded",
		)
	})

	section("groupByScope")

	await it("buckets actions by scope and defaults unscoped", () => {
		const grouped = groupByScope([
			action({ idempotencyKey: "1", scope: "agent-a" }),
			action({ idempotencyKey: "2", scope: "agent-a" }),
			action({ idempotencyKey: "3", scope: null }),
		])
		assert.equal(grouped.get("agent-a")!.length, 2)
		assert.equal(grouped.get("(unscoped)")!.length, 1)
	})

	summary()
})()
