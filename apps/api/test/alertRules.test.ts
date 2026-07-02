// Phase 4-D - alert rules store + dispatcher rule routing. Zero network: the
// store is in-memory and transports are capture stubs.
import { assert, it, section, summary } from "./_assert"
import { AlertDispatcher, DEFAULT_RULES, type Alert, type AlertTransport } from "../src/alerts"
import { MemAlertRuleStore } from "../src/alertRules"
import type { DomainEvent } from "../src/events"

function evt(over: Partial<DomainEvent> = {}): DomainEvent {
    return {
        type: "action.transition",
        orgId: "o1",
        idempotencyKey: "k1",
        tool: "refund",
        scope: "agent1",
        cost: 0,
        status: "awaiting_approval",
        reason: "too big",
        at: "",
        ...over,
    }
}

function capture(name: string) {
    const hits: Alert[] = []
    const t: AlertTransport = { name, send: async (a) => { hits.push(a) } }
    return { t, hits }
}

console.log("belay-cloud-api alert-rules tests")

await (async () => {
    section("alert rule store")

    await it("create + list is org-scoped and newest-first, enabled by default", async () => {
        const s = new MemAlertRuleStore()
        await s.create("o1", "r1", { name: "a", trigger: "failed", channels: ["slack"] })
        await s.create("o1", "r2", { name: "b", trigger: "denied", channels: ["email"] })
        await s.create("o2", "r3", { name: "c", trigger: "failed", channels: ["slack"] })
        const rules = await s.list("o1")
        assert.equal(rules.length, 2)
        assert.equal(rules[0].id, "r2")
        assert.equal(rules[0].enabled, true)
    })

    await it("update patches only provided fields; missing id returns undefined", async () => {
        const s = new MemAlertRuleStore()
        await s.create("o1", "r1", { name: "a", trigger: "failed", channels: ["slack"] })
        const upd = await s.update("o1", "r1", { name: "renamed", enabled: false })
        assert.equal(upd?.name, "renamed")
        assert.equal(upd?.enabled, false)
        assert.equal(upd?.trigger, "failed")
        assert.equal(await s.update("o1", "nope", { name: "x" }), undefined)
    })

    await it("remove is org-scoped and reports whether a row was deleted", async () => {
        const s = new MemAlertRuleStore()
        await s.create("o1", "r1", { name: "a", trigger: "failed", channels: ["slack"] })
        assert.equal(await s.remove("o2", "r1"), false)
        assert.equal(await s.remove("o1", "r1"), true)
        assert.equal((await s.list("o1")).length, 0)
    })

    await it("matching returns only enabled rules for the trigger, honoring the scope wildcard", async () => {
        const s = new MemAlertRuleStore()
        await s.create("o1", "r1", { name: "all scopes", trigger: "failed", channels: ["slack"] })
        await s.create("o1", "r2", { name: "disabled", trigger: "failed", channels: ["email"], enabled: false })
        await s.create("o1", "r3", { name: "denied only", trigger: "denied", channels: ["slack"] })
        const m = await s.matching("o1", "failed", "agent9")
        assert.equal(m.length, 1)
        assert.equal(m[0].id, "r1")
    })

    section("dispatcher rule routing")

    await it("with no rule store, fans out to every transport (unchanged behavior)", async () => {
        const a = capture("slack")
        const b = capture("email")
        await new AlertDispatcher([a.t, b.t]).handle(evt())
        assert.equal(a.hits.length, 1)
        assert.equal(b.hits.length, 1)
    })

    await it("an org with no configured rules falls back to every transport", async () => {
        const a = capture("slack")
        const b = capture("email")
        const store = new MemAlertRuleStore()
        await new AlertDispatcher([a.t, b.t], DEFAULT_RULES, store).handle(evt())
        assert.equal(a.hits.length, 1)
        assert.equal(b.hits.length, 1)
    })

    await it("a rule routes the alert only to its named channels", async () => {
        const a = capture("slack")
        const b = capture("email")
        const store = new MemAlertRuleStore()
        await store.create("o1", "r1", { name: "approvals to slack", trigger: "awaiting_approval", channels: ["slack"] })
        await new AlertDispatcher([a.t, b.t], DEFAULT_RULES, store).handle(evt())
        assert.equal(a.hits.length, 1)
        assert.equal(b.hits.length, 0)
    })

    await it("an org with rules but none matching the trigger stays silent", async () => {
        const a = capture("slack")
        const store = new MemAlertRuleStore()
        await store.create("o1", "r1", { name: "denials only", trigger: "denied", channels: ["slack"] })
        await new AlertDispatcher([a.t], DEFAULT_RULES, store).handle(evt({ status: "awaiting_approval" }))
        assert.equal(a.hits.length, 0)
    })

    await it("a scope-filtered rule fires only for its agent", async () => {
        const a = capture("slack")
        const store = new MemAlertRuleStore()
        await store.create("o1", "r1", { name: "agent1 only", trigger: "awaiting_approval", scope: "agent1", channels: ["slack"] })
        const d = new AlertDispatcher([a.t], DEFAULT_RULES, store)
        await d.handle(evt({ scope: "agent2" }))
        assert.equal(a.hits.length, 0)
        await d.handle(evt({ scope: "agent1" }))
        assert.equal(a.hits.length, 1)
    })

    summary()
})()