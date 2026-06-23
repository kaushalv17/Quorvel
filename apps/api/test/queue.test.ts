// Part 7 — queue + bus behaviour: retry, dead-lettering, ordering, fan-out, and
// the service emitting DomainEvents through a bus.
import { assert, it, section, summary } from "./_assert"
import { InMemoryQueue } from "../src/queue"
import { InProcessBus, QueueBus, type Subscriber } from "../src/bus"
import { QuorvelCloudService } from "../src/service"
import { MemStore } from "../src/store"
import type { DomainEvent } from "../src/events"

console.log("belay-cloud-api queue/bus tests")

await (async () => {
	section("InMemoryQueue")

	await it("processes an enqueued job", async () => {
		const q = new InMemoryQueue<number>({ attempts: 1, backoffMs: 0 })
		const seen: number[] = []
		q.process(async (n) => { seen.push(n) })
		await q.enqueue(1)
		await q.enqueue(2)
		await q.drain()
		assert.deepEqual(seen, [1, 2])
	})

	await it("preserves ordering across jobs", async () => {
		const q = new InMemoryQueue<number>({ attempts: 1, backoffMs: 0 })
		const seen: number[] = []
		q.process(async (n) => {
			if (n === 1) await new Promise((r) => setTimeout(r, 5))
			seen.push(n)
		})
		await q.enqueue(1)
		await q.enqueue(2)
		await q.drain()
		assert.deepEqual(seen, [1, 2])
	})

	await it("retries a flaky handler until it succeeds", async () => {
		const q = new InMemoryQueue<string>({ attempts: 5, backoffMs: 0 })
		let tries = 0
		q.process(async () => {
			tries++
			if (tries < 3) throw new Error("transient")
		})
		await q.enqueue("job")
		await q.drain()
		assert.equal(tries, 3)
		assert.equal(q.deadLetters().length, 0)
	})

	await it("dead-letters after exhausting attempts", async () => {
		const q = new InMemoryQueue<string>({ attempts: 3, backoffMs: 0 })
		q.process(async () => { throw new Error("always fails") })
		await q.enqueue("doomed")
		await q.drain()
		assert.equal(q.deadLetters().length, 1)
		assert.equal(q.deadLetters()[0].attempts, 3)
		assert.match(q.deadLetters()[0].error, /always fails/)
	})

	section("buses")

	await it("InProcessBus fans out to all subscribers in order", async () => {
		const order: string[] = []
		const a: Subscriber = async () => { order.push("a") }
		const b: Subscriber = async () => { order.push("b") }
		const bus = new InProcessBus([a, b])
		await bus.publish({ type: "action.created", orgId: "o", idempotencyKey: "k", tool: "t", scope: null, cost: 0, status: "pending", at: "" })
		assert.deepEqual(order, ["a", "b"])
	})

	await it("QueueBus delivers events through the queue with retry", async () => {
		const q = new InMemoryQueue<DomainEvent>({ attempts: 4, backoffMs: 0 })
		const received: string[] = []
		let flaky = 0
		const sub: Subscriber = async (e) => {
			if (flaky++ < 1) throw new Error("once")
			received.push(e.idempotencyKey)
		}
		const bus = new QueueBus(q, [sub])
		await bus.publish({ type: "action.created", orgId: "o", idempotencyKey: "evt", tool: "t", scope: null, cost: 0, status: "pending", at: "" })
		await q.drain()
		assert.deepEqual(received, ["evt"])
	})

	section("service emits events through a bus")

	await it("insertPending emits action.created; marks emit action.transition", async () => {
		const events: DomainEvent[] = []
		const bus = new InProcessBus([async (e) => { events.push(e) }])
		const svc = new QuorvelCloudService(new MemStore(), { bus })
		await svc.insertPending("o", { idempotencyKey: "k", scope: "agent1", tool: "email" })
		await svc.markRunning("o", "k")
		await svc.markSucceeded("o", "k", null)
		assert.deepEqual(events.map((e) => `${e.type}:${e.status}`), [
			"action.created:pending",
			"action.transition:running",
			"action.transition:succeeded",
		])
		assert.equal(events[0].scope, "agent1")
	})

	await it("duplicate insertPending does NOT emit a second created event", async () => {
		const events: DomainEvent[] = []
		const bus = new InProcessBus([async (e) => { events.push(e) }])
		const svc = new QuorvelCloudService(new MemStore(), { bus })
		await svc.insertPending("o", { idempotencyKey: "dup", scope: null, tool: "t" })
		await svc.insertPending("o", { idempotencyKey: "dup", scope: null, tool: "t" })
		assert.equal(events.filter((e) => e.type === "action.created").length, 1)
	})

	summary()
})()
