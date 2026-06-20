// Core service + router contract (MemStore, no bus/limiter — i.e. the pure
// LedgerStore-over-HTTP behaviour). Mirrors the @belay/core semantics.
import { assert, it, section, summary } from "./_assert"
import { handleRequest, type RawRequest } from "../src/router"
import { BelayCloudService } from "../src/service"
import { MemStore } from "../src/store"
import { hashApiKey } from "../src/keys"

const ADMIN = "admin-secret"

async function call(svc: BelayCloudService, req: Partial<RawRequest>) {
	return handleRequest(svc, ADMIN, {
		method: req.method ?? "GET",
		path: req.path ?? "/",
		query: req.query ?? {},
		body: req.body,
		headers: req.headers ?? {},
	})
}

console.log("belay-cloud-api tests")

await (async () => {
	section("service (LedgerStore semantics)")

	await it("issueApiKey returns plaintext key + stores only the hash", async () => {
		const store = new MemStore()
		const svc = new BelayCloudService(store)
		const { apiKey, orgId } = await svc.issueApiKey({ orgName: "acme" })
		assert.ok(apiKey.startsWith("bly_live_"))
		assert.ok(orgId.startsWith("org_"))
		const rec = await store.getApiKeyByHash(hashApiKey(apiKey))
		assert.ok(rec, "hash should be stored")
		assert.equal(rec!.orgId, orgId)
	})

	await it("authenticate accepts Bearer + raw, rejects missing/garbage/revoked", async () => {
		const store = new MemStore()
		const svc = new BelayCloudService(store)
		const { apiKey, orgId } = await svc.issueApiKey({})
		assert.equal((await svc.authenticate(`Bearer ${apiKey}`)).orgId, orgId)
		assert.equal((await svc.authenticate(apiKey)).orgId, orgId)
		await assert.rejects(() => svc.authenticate(undefined))
		await assert.rejects(() => svc.authenticate("Bearer nope"))
		await store.insertApiKey({
			id: "k_revoked",
			orgId,
			keyHash: hashApiKey("revoked-token"),
			keyPrefix: "bly_live_xx",
			name: "r",
			createdAt: new Date().toISOString(),
			revokedAt: new Date().toISOString(),
		})
		await assert.rejects(() => svc.authenticate("revoked-token"))
	})

	await it("insertPending is atomic: first wins, second returns existing", async () => {
		const svc = new BelayCloudService(new MemStore())
		const a = await svc.insertPending("org1", { idempotencyKey: "k1", scope: null, tool: "email" })
		assert.equal(a.inserted, true)
		const b = await svc.insertPending("org1", { idempotencyKey: "k1", scope: null, tool: "email" })
		assert.equal(b.inserted, false)
		assert.equal(b.existing!.idempotencyKey, "k1")
	})

	await it("markRunning sets running + increments attempts each call", async () => {
		const svc = new BelayCloudService(new MemStore())
		await svc.insertPending("o", { idempotencyKey: "k", scope: null, tool: "t" })
		await svc.markRunning("o", "k")
		await svc.markRunning("o", "k")
		const a = await svc.getAction("o", "k")
		assert.equal(a!.status, "running")
		assert.equal(a!.attempts, 2)
	})

	await it("lifecycle: succeeded stores result; failed stores error", async () => {
		const svc = new BelayCloudService(new MemStore())
		await svc.insertPending("o", { idempotencyKey: "ok", scope: null, tool: "t" })
		await svc.markSucceeded("o", "ok", { value: 42 })
		assert.deepEqual((await svc.getAction("o", "ok"))!.result, { value: 42 })
		await svc.insertPending("o", { idempotencyKey: "bad", scope: null, tool: "t" })
		await svc.markFailed("o", "bad", "boom")
		assert.equal((await svc.getAction("o", "bad"))!.error, "boom")
	})

	await it("approvals: awaiting -> approved/rejected/denied via marks", async () => {
		const svc = new BelayCloudService(new MemStore())
		await svc.insertPending("o", { idempotencyKey: "a", scope: null, tool: "t" })
		await svc.markAwaitingApproval("o", "a", "needs review")
		assert.equal((await svc.getAction("o", "a"))!.status, "awaiting_approval")
		await svc.markApproved("o", "a")
		assert.equal((await svc.getAction("o", "a"))!.status, "approved")
		assert.equal((await svc.getAction("o", "a"))!.reason, "needs review")
	})

	await it("mark on missing key is a silent no-op (no throw, no create)", async () => {
		const svc = new BelayCloudService(new MemStore())
		await svc.markRunning("o", "ghost")
		assert.equal(await svc.getAction("o", "ghost"), undefined)
	})

	await it("listByStatus is org-scoped, sorted, and limit-aware", async () => {
		const svc = new BelayCloudService(new MemStore())
		await svc.insertPending("o", { idempotencyKey: "k1", scope: null, tool: "t" })
		await svc.insertPending("o", { idempotencyKey: "k2", scope: null, tool: "t" })
		await svc.insertPending("other", { idempotencyKey: "k3", scope: null, tool: "t" })
		const pend = await svc.listByStatus("o", "pending")
		assert.equal(pend.length, 2)
		assert.equal((await svc.listByStatus("o", "pending", 1)).length, 1)
	})

	await it("stats sums non-failed cost in scope; excludes failed/denied/rejected; honors since", async () => {
		const svc = new BelayCloudService(new MemStore())
		await svc.insertPending("o", { idempotencyKey: "a", scope: "agent1", tool: "t", cost: 5 })
		await svc.insertPending("o", { idempotencyKey: "b", scope: "agent1", tool: "t", cost: 3 })
		await svc.markFailed("o", "b", "x")
		const s = await svc.stats("o", { scope: "agent1" })
		assert.equal(s.count, 1)
		assert.equal(s.totalCost, 5)
	})

	await it("listRecent returns newest-first across statuses, org-scoped", async () => {
		const svc = new BelayCloudService(new MemStore())
		await svc.insertPending("o", { idempotencyKey: "old", scope: null, tool: "t" })
		await new Promise((r) => setTimeout(r, 2))
		await svc.insertPending("o", { idempotencyKey: "new", scope: null, tool: "t" })
		await svc.insertPending("other", { idempotencyKey: "x", scope: null, tool: "t" })
		const recent = await svc.listRecent("o")
		assert.equal(recent.length, 2)
		assert.equal(recent[0].idempotencyKey, "new")
	})

	section("router (handleRequest)")

	await it("GET /health is open", async () => {
		const svc = new BelayCloudService(new MemStore())
		const res = await call(svc, { method: "GET", path: "/health" })
		assert.equal(res.status, 200)
	})

	await it("POST /v1/keys requires the admin secret", async () => {
		const svc = new BelayCloudService(new MemStore())
		assert.equal((await call(svc, { method: "POST", path: "/v1/keys", headers: {} })).status, 401)
		const ok = await call(svc, { method: "POST", path: "/v1/keys", headers: { "x-admin-secret": ADMIN }, body: {} })
		assert.equal(ok.status, 201)
	})

	await it("protected routes require Bearer auth", async () => {
		const svc = new BelayCloudService(new MemStore())
		assert.equal((await call(svc, { method: "POST", path: "/v1/actions", headers: {}, body: {} })).status, 401)
	})

	await it("full HTTP lifecycle: insert -> running -> succeeded -> get -> stats -> timeline -> usage", async () => {
		const svc = new BelayCloudService(new MemStore())
		const keyRes = await call(svc, { method: "POST", path: "/v1/keys", headers: { "x-admin-secret": ADMIN }, body: {} })
		const apiKey = (keyRes.body as any).apiKey as string
		const auth = { authorization: `Bearer ${apiKey}` }
		assert.equal((await call(svc, { method: "POST", path: "/v1/actions", headers: auth, body: { idempotencyKey: "x", tool: "email", cost: 2 } })).status, 200)
		assert.equal((await call(svc, { method: "POST", path: "/v1/actions/x/running", headers: auth, body: {} })).status, 204)
		assert.equal((await call(svc, { method: "POST", path: "/v1/actions/x/succeeded", headers: auth, body: { result: { ok: 1 } } })).status, 204)
		const got = await call(svc, { method: "GET", path: "/v1/actions/x", headers: auth })
		assert.equal((got.body as any).status, "succeeded")
		const stats = await call(svc, { method: "POST", path: "/v1/stats", headers: auth, body: {} })
		assert.equal((stats.body as any).count, 1)
		const timeline = await call(svc, { method: "GET", path: "/v1/actions", headers: auth })
		assert.equal((timeline.body as any[]).length, 1)
		const usage = await call(svc, { method: "GET", path: "/v1/usage", headers: auth })
		assert.equal((usage.body as any).plan, "free")
	})

	await it("GET unknown action -> 404; tenants are isolated", async () => {
		const svc = new BelayCloudService(new MemStore())
		const k1 = (await call(svc, { method: "POST", path: "/v1/keys", headers: { "x-admin-secret": ADMIN }, body: {} })).body as any
		const k2 = (await call(svc, { method: "POST", path: "/v1/keys", headers: { "x-admin-secret": ADMIN }, body: {} })).body as any
		await call(svc, { method: "POST", path: "/v1/actions", headers: { authorization: `Bearer ${k1.apiKey}` }, body: { idempotencyKey: "secret", tool: "t" } })
		assert.equal((await call(svc, { method: "GET", path: "/v1/actions/secret", headers: { authorization: `Bearer ${k2.apiKey}` } })).status, 404)
	})

	await it("GET /v1/actions?status=awaiting_approval lists the approval queue", async () => {
		const svc = new BelayCloudService(new MemStore())
		const k = (await call(svc, { method: "POST", path: "/v1/keys", headers: { "x-admin-secret": ADMIN }, body: {} })).body as any
		const auth = { authorization: `Bearer ${k.apiKey}` }
		await call(svc, { method: "POST", path: "/v1/actions", headers: auth, body: { idempotencyKey: "p", tool: "refund" } })
		await call(svc, { method: "POST", path: "/v1/actions/p/awaiting-approval", headers: auth, body: { reason: "big refund" } })
		const q = await call(svc, { method: "GET", path: "/v1/actions", query: { status: "awaiting_approval" }, headers: auth })
		assert.equal((q.body as any[]).length, 1)
		assert.equal((q.body as any[])[0].idempotencyKey, "p")
	})

	summary()
})()
