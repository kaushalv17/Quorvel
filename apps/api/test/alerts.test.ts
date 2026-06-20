// Part 8 — alert transports + dispatcher. All HTTP goes through an injected fake
// fetch, so these tests make zero network calls.
import { assert, it, section, summary } from "./_assert"
import {
	AlertDispatcher,
	EmailTransport,
	SlackTransport,
	WebhookTransport,
	type Alert,
	type AlertTransport,
	type FetchLike,
	type FetchResponse,
} from "../src/alerts"
import { InProcessBus } from "../src/bus"
import type { DomainEvent } from "../src/events"

interface Call { url: string; method?: string; headers?: Record<string, string>; body?: string }

function fakeFetch(ok = true, status = 200): { fetch: FetchLike; calls: Call[] } {
	const calls: Call[] = []
	const fetch: FetchLike = async (url, init) => {
		calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body })
		const res: FetchResponse = { ok, status, text: async () => "" }
		return res
	}
	return { fetch, calls }
}

function evt(status: DomainEvent["status"], type: DomainEvent["type"] = "action.transition"): DomainEvent {
	return { type, orgId: "o", idempotencyKey: "k1", tool: "refund", scope: "agent1", cost: 0, status, reason: "too big", at: "" }
}

console.log("belay-cloud-api alerts tests")

await (async () => {
	section("transports")

	await it("SlackTransport posts formatted text", async () => {
		const { fetch, calls } = fakeFetch()
		await new SlackTransport("https://hooks.slack.test/x", fetch).send({ level: "warning", title: "Approval needed", body: "please review", event: evt("awaiting_approval") })
		assert.equal(calls.length, 1)
		assert.equal(calls[0].url, "https://hooks.slack.test/x")
		assert.match(calls[0].body!, /Approval needed/)
		assert.match(calls[0].body!, /please review/)
	})

	await it("SlackTransport throws on non-2xx", async () => {
		const { fetch } = fakeFetch(false, 500)
		await assert.rejects(() => new SlackTransport("u", fetch).send({ level: "info", title: "t", body: "b", event: evt("failed") }))
	})

	await it("WebhookTransport posts a JSON envelope with custom headers", async () => {
		const { fetch, calls } = fakeFetch()
		await new WebhookTransport("https://hook.test", fetch, { "x-secret": "s" }).send({ level: "critical", title: "Denied", body: "nope", event: evt("denied") })
		assert.equal(calls[0].headers!["x-secret"], "s")
		const parsed = JSON.parse(calls[0].body!)
		assert.equal(parsed.level, "critical")
		assert.equal(parsed.event.status, "denied")
	})

	await it("EmailTransport posts to Resend with bearer auth", async () => {
		const { fetch, calls } = fakeFetch()
		await new EmailTransport({ apiKey: "re_123", from: "a@x.io", to: "b@x.io" }, fetch).send({ level: "warning", title: "Subject", body: "Body", event: evt("awaiting_approval") })
		assert.match(calls[0].url, /resend\.com/)
		assert.equal(calls[0].headers!["authorization"], "Bearer re_123")
		const parsed = JSON.parse(calls[0].body!)
		assert.equal(parsed.subject, "Subject")
	})

	section("dispatcher rules")

	await it("fires approval-needed to every transport", async () => {
		const hits: Alert[] = []
		const t: AlertTransport = { name: "capture", send: async (a) => { hits.push(a) } }
		const t2: AlertTransport = { name: "capture2", send: async (a) => { hits.push(a) } }
		await new AlertDispatcher([t, t2]).handle(evt("awaiting_approval"))
		assert.equal(hits.length, 2)
		assert.equal(hits[0].title, "Approval needed")
	})

	await it("fires policy-denied as critical", async () => {
		const hits: Alert[] = []
		const t: AlertTransport = { name: "capture", send: async (a) => { hits.push(a) } }
		await new AlertDispatcher([t]).handle(evt("denied"))
		assert.equal(hits[0].level, "critical")
	})

	await it("ignores unrelated events (succeeded)", async () => {
		const hits: Alert[] = []
		const t: AlertTransport = { name: "capture", send: async (a) => { hits.push(a) } }
		await new AlertDispatcher([t]).handle(evt("succeeded"))
		assert.equal(hits.length, 0)
	})

	await it("works as a bus subscriber end-to-end", async () => {
		const { fetch, calls } = fakeFetch()
		const dispatcher = new AlertDispatcher([new SlackTransport("https://hooks.slack.test/x", fetch)])
		const bus = new InProcessBus([dispatcher.handle])
		await bus.publish(evt("awaiting_approval"))
		assert.equal(calls.length, 1)
	})

	summary()
})()
