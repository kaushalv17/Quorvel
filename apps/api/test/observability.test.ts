import { section, it, summary, assert } from "./_assert"
import {
    MemActionEventLog,
    makeActionEventSink,
    domainEventToActionEventInput,
} from "../src/actionEvents"
import { QuorvelCloudService } from "../src/service"
import { MemStore } from "../src/store"
import { handleRequest } from "../src/router"
import type { DomainEvent } from "../src/events"
import type { EventBus } from "../src/bus"

section("observability: action event log")

await it("appends events and lists them for a run in insertion order", async () => {
    const log = new MemActionEventLog()
    await log.append({ orgId: "o1", idempotencyKey: "run1", type: "created", status: "pending" })
    await log.append({ orgId: "o1", idempotencyKey: "run1", type: "transition", status: "running", attempt: 1 })
    await log.append({ orgId: "o1", idempotencyKey: "run1", type: "transition", status: "succeeded", attempt: 1 })
    const events = await log.listByRun("o1", "run1")
    assert(events.length === 3, "three events recorded")
    assert(events[0].status === "pending", "first event is pending")
    assert(events[1].status === "running", "second event is running")
    assert(events[2].status === "succeeded", "third event is succeeded")
})

await it("defaults attempt/reason/error and auto-sets a timestamp + id", async () => {
    const log = new MemActionEventLog()
    const ev = await log.append({ orgId: "o1", idempotencyKey: "run1", type: "created", status: "pending" })
    assert(ev.attempt === 0, "attempt defaults to 0")
    assert(ev.reason === null, "reason defaults to null")
    assert(ev.error === null, "error defaults to null")
    assert(typeof ev.at === "string" && ev.at.length > 0, "timestamp auto-set")
    assert(ev.id === "1", "first id is 1")
})

await it("isolates events by org and by run", async () => {
    const log = new MemActionEventLog()
    await log.append({ orgId: "o1", idempotencyKey: "run1", type: "created", status: "pending" })
    await log.append({ orgId: "o1", idempotencyKey: "run2", type: "created", status: "pending" })
    await log.append({ orgId: "o2", idempotencyKey: "run1", type: "created", status: "pending" })
    assert((await log.listByRun("o1", "run1")).length === 1, "org1/run1 sees only its own event")
    assert((await log.listByRun("o2", "run1")).length === 1, "org2/run1 is isolated")
    assert((await log.listByRun("o1", "missing")).length === 0, "unknown run is empty")
})

await it("listRecent returns newest first and respects limit", async () => {
    const log = new MemActionEventLog()
    await log.append({ orgId: "o1", idempotencyKey: "run1", type: "created", status: "pending" })
    await log.append({ orgId: "o1", idempotencyKey: "run1", type: "transition", status: "running" })
    await log.append({ orgId: "o1", idempotencyKey: "run1", type: "transition", status: "failed", error: "boom" })
    const recent = await log.listRecent("o1")
    assert(recent.length === 3, "all three returned")
    assert(recent[0].status === "failed", "newest first")
    const limited = await log.listRecent("o1", { limit: 2 })
    assert(limited.length === 2, "limit respected")
    assert(limited[0].status === "failed", "limited keeps newest")
})

await it("listRecent filters by status and by run", async () => {
    const log = new MemActionEventLog()
    await log.append({ orgId: "o1", idempotencyKey: "run1", type: "transition", status: "failed", error: "a" })
    await log.append({ orgId: "o1", idempotencyKey: "run2", type: "transition", status: "succeeded" })
    await log.append({ orgId: "o1", idempotencyKey: "run3", type: "transition", status: "failed", error: "b" })
    const failed = await log.listRecent("o1", { status: "failed" })
    assert(failed.length === 2, "only failed events")
    assert(failed.every((e) => e.status === "failed"), "all failed")
    const run2 = await log.listRecent("o1", { idempotencyKey: "run2" })
    assert(run2.length === 1, "filter by run")
    assert(run2[0].status === "succeeded", "correct run event")
})

await it("maps a DomainEvent onto a timeline input", async () => {
    const ev: DomainEvent = {
        type: "action.transition", orgId: "o1", idempotencyKey: "run1",
        tool: "t", scope: "s", cost: 0, status: "failed", reason: "policy",
        at: "2026-01-01T00:00:00.000Z",
    }
    const input = domainEventToActionEventInput(ev)
    assert(input.type === "transition", "transition mapped")
    assert(input.status === "failed", "status carried")
    assert(input.reason === "policy", "reason carried")
    assert(input.idempotencyKey === "run1", "run key carried")
    assert(input.at === ev.at, "timestamp carried")
    const created = domainEventToActionEventInput({ ...ev, type: "action.created" })
    assert(created.type === "created", "created mapped")
})

await it("event sink persists created + transition events to the run timeline", async () => {
    const log = new MemActionEventLog()
    const sink = makeActionEventSink(log)
    await sink({
        type: "action.created", orgId: "o1", idempotencyKey: "run1",
        tool: "t", scope: null, cost: 1, status: "pending",
        at: "2026-01-01T00:00:00.000Z",
    })
    await sink({
        type: "action.transition", orgId: "o1", idempotencyKey: "run1",
        tool: "t", scope: null, cost: 1, status: "succeeded",
        at: "2026-01-01T00:00:01.000Z",
    })
    const timeline = await log.listByRun("o1", "run1")
    assert(timeline.length === 2, "two events persisted")
    assert(timeline[0].type === "created" && timeline[0].status === "pending", "created first")
    assert(timeline[1].type === "transition" && timeline[1].status === "succeeded", "transition second")
})

section("observability: service + HTTP read surface")

const fakeBus = (log: MemActionEventLog): EventBus => {
    const sink = makeActionEventSink(log)
    return { publish: async (ev: DomainEvent) => { await sink(ev) } } as unknown as EventBus
}

await it("runTimeline returns the action plus its ordered event log", async () => {
    const store = new MemStore()
    const log = new MemActionEventLog()
    const svc = new QuorvelCloudService(store, { bus: fakeBus(log), actionEventLog: log })
    await svc.insertPending("o1", { idempotencyKey: "run1", scope: null, tool: "email.send" })
    await svc.markRunning("o1", "run1")
    await svc.markSucceeded("o1", "run1", { ok: true })
    const timeline = await svc.runTimeline("o1", "run1")
    assert(timeline !== undefined, "timeline found")
    assert(timeline!.action.idempotencyKey === "run1", "action returned")
    assert(timeline!.action.status === "succeeded", "final status on the action row")
    assert(timeline!.events.length === 3, "created + running + succeeded")
    assert(timeline!.events[0].type === "created", "first event is created")
    assert(timeline!.events[2].status === "succeeded", "last event is succeeded")
})

await it("listEvents returns a cross-run feed, newest first, filterable", async () => {
    const store = new MemStore()
    const log = new MemActionEventLog()
    const svc = new QuorvelCloudService(store, { bus: fakeBus(log), actionEventLog: log })
    await svc.insertPending("o1", { idempotencyKey: "r1", scope: null, tool: "t" })
    await svc.insertPending("o1", { idempotencyKey: "r2", scope: null, tool: "t" })
    await svc.markFailed("o1", "r1", "boom")
    const all = await svc.listEvents("o1", {})
    assert(all.length === 3, "created x2 + failed")
    assert(all[0].status === "failed", "newest first")
    const failed = await svc.listEvents("o1", { status: "failed" })
    assert(failed.length === 1 && failed[0].idempotencyKey === "r1", "status filter")
    const r2 = await svc.listEvents("o1", { idempotencyKey: "r2" })
    assert(r2.length === 1 && r2[0].type === "created", "run filter")
})

await it("HTTP: /v1/actions/:key/events + /v1/events route through handleRequest", async () => {
    const store = new MemStore()
    const log = new MemActionEventLog()
    const svc = new QuorvelCloudService(store, { bus: fakeBus(log), actionEventLog: log })
    const issued = await svc.issueApiKey({})
    const auth = { authorization: "Bearer " + issued.apiKey }
    const call = (method: string, path: string, body: unknown = null) =>
        handleRequest(svc, "admin", { method, path, query: {}, headers: auth, body })

    await call("POST", "/v1/actions", { idempotencyKey: "run1", tool: "email.send" })
    await call("POST", "/v1/actions/run1/running")
    await call("POST", "/v1/actions/run1/succeeded", { result: { ok: true } })

    const tl = await call("GET", "/v1/actions/run1/events")
    assert(tl.status === 200, "timeline 200")
    const tb = tl.body as { action: { status: string }; events: unknown[] }
    assert(tb.action.status === "succeeded", "action embedded in timeline")
    assert(tb.events.length === 3, "three events in timeline")

    const feed = await call("GET", "/v1/events")
    assert(feed.status === 200, "events feed 200")
    assert((feed.body as unknown[]).length === 3, "feed lists three events")

    const missing = await call("GET", "/v1/actions/nope/events")
    assert(missing.status === 404, "unknown run -> 404")
})

summary()