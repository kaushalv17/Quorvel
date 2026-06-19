import { describe, it, expect } from "vitest"
import { WorkflowEngine, defineWorkflow } from "../src/workflow.js"
import { InMemoryWorkflowStore } from "../src/workflow-store.js"
import { WorkflowDeterminismError } from "../src/errors.js"

function setup(now = { t: 0 }) {
  const store = new InMemoryWorkflowStore()
  const engine = new WorkflowEngine({ store, clock: () => now.t })
  return { store, engine, now }
}

describe("workflow: checkpointing", () => {
  it("runs each step in order and completes with a result", async () => {
    const { engine } = setup()
    const log: string[] = []
    const wf = defineWorkflow<{ email: string }, { id: string }>(
      "onboard",
      async (ctx, input) => {
        const user = await ctx.step("create", async () => {
          log.push("create")
          return { id: "u1", email: input.email }
        })
        await ctx.step("welcome", async () => {
          log.push("welcome")
          return null
        })
        return { id: user.id }
      },
    )
    engine.register(wf)
    const run = await engine.start("onboard", {
      workflowId: "w1",
      input: { email: "a@b.com" },
    })
    expect(run.status).toBe("completed")
    expect(run.result).toEqual({ id: "u1" })
    expect(log).toEqual(["create", "welcome"])

    // Resuming a completed workflow must not re-run anything.
    await engine.resume("w1")
    expect(log).toEqual(["create", "welcome"])
  })

  it("never re-runs a committed step when resumed mid-flight", async () => {
    const { engine } = setup()
    let charges = 0
    const wf = defineWorkflow("c", async (ctx) => {
      await ctx.step("charge", async () => {
        charges += 1
        return charges
      })
      await ctx.waitForSignal("go") // suspends right after charging
      return "done"
    })
    engine.register(wf)
    await engine.start("c", { workflowId: "w2" })
    expect(charges).toBe(1)
    await engine.resume("w2")
    await engine.resume("w2")
    expect(charges).toBe(1) // charge committed exactly once
  })
})

describe("workflow: durable sleep", () => {
  it("suspends on sleep and only resumes once the timer is due", async () => {
    const { engine, store, now } = setup({ t: 1000 })
    const log: string[] = []
    const wf = defineWorkflow("timed", async (ctx) => {
      await ctx.step("a", async () => {
        log.push("a")
      })
      await ctx.sleep("wait", 5000)
      await ctx.step("b", async () => {
        log.push("b")
      })
    })
    engine.register(wf)

    const r1 = await engine.start("timed", { workflowId: "w3" })
    expect(r1.status).toBe("suspended")
    expect(log).toEqual(["a"])

    now.t = 2000 // not due yet (fires at 6000)
    expect(await engine.tick()).toBe(0)
    expect((await store.getRun("w3"))?.status).toBe("suspended")

    now.t = 6000 // due
    expect(await engine.tick()).toBe(1)
    expect(log).toEqual(["a", "b"])
    expect((await store.getRun("w3"))?.status).toBe("completed")
  })
})

describe("workflow: signals", () => {
  it("waits for an external signal, then resumes with its payload", async () => {
    const { engine } = setup()
    const wf = defineWorkflow<unknown, { rating: number }>(
      "survey",
      async (ctx) => {
        const res = await ctx.waitForSignal<{ rating: number }>("survey-done")
        return { rating: res.rating }
      },
    )
    engine.register(wf)
    const r1 = await engine.start("survey", { workflowId: "w4" })
    expect(r1.status).toBe("suspended")
    const r2 = await engine.signal("w4", "survey-done", { rating: 5 })
    expect(r2.status).toBe("completed")
    expect(r2.result).toEqual({ rating: 5 })
  })

  it("buffers a signal that arrives before its wait", async () => {
    const { engine } = setup()
    const wf = defineWorkflow("two", async (ctx) => {
      const a = await ctx.waitForSignal<number>("A")
      const b = await ctx.waitForSignal<number>("B")
      return a + b
    })
    engine.register(wf)
    await engine.start("two", { workflowId: "w5" }) // suspended waiting A
    // B arrives early — only A is pending, so B is buffered.
    await engine.signal("w5", "B", 20)
    expect((await engine.getRun("w5"))?.status).toBe("suspended")
    // A arrives — resume; B is then consumed from the buffer.
    const r = await engine.signal("w5", "A", 22)
    expect(r.status).toBe("completed")
    expect(r.result).toBe(42)
  })
})

describe("workflow: determinism guard", () => {
  it("throws if the replayed command sequence changes incompatibly", async () => {
    const { engine } = setup()
    const v1 = defineWorkflow("v", async (ctx) => {
      await ctx.step("first", async () => 1)
      await ctx.waitForSignal("go")
      return "v1"
    })
    engine.register(v1)
    await engine.start("v", { workflowId: "w6" }) // records step "first", suspends

    // Deploy an incompatible version under the same name.
    const v2 = defineWorkflow("v", async (ctx) => {
      await ctx.sleep("first", 100) // seq 0 was a step, now a sleep
      return "v2"
    })
    engine.register(v2)
    await expect(engine.resume("w6")).rejects.toBeInstanceOf(
      WorkflowDeterminismError,
    )
  })
})

describe("workflow: failure + retry", () => {
  it("fails on a throwing step, then resumes cleanly after the fix", async () => {
    const { engine, store } = setup()
    let fail = true
    let calls = 0
    const wf = defineWorkflow("flaky", async (ctx) => {
      await ctx.step("ok", async () => "ok")
      await ctx.step("risky", async () => {
        calls++
        if (fail) throw new Error("boom")
        return "fixed"
      })
      return "done"
    })
    engine.register(wf)

    await expect(
      engine.start("flaky", { workflowId: "w7" }),
    ).rejects.toThrow(/boom/)
    expect((await store.getRun("w7"))?.status).toBe("failed")
    expect(calls).toBe(1)

    // "ok" is memoized; only "risky" retries on resume.
    fail = false
    const r = await engine.resume("w7")
    expect(r.status).toBe("completed")
    expect(calls).toBe(2)
  })

  it("retries a flaky step in-process up to the configured limit", async () => {
    const { engine } = setup()
    let attempts = 0
    const wf = defineWorkflow("retry", async (ctx) => {
      return ctx.step(
        "net",
        async () => {
          attempts++
          if (attempts < 3) throw new Error("transient")
          return attempts
        },
        { retries: 3, backoffMs: 0 },
      )
    })
    engine.register(wf)
    const r = await engine.start("retry", { workflowId: "w8" })
    expect(r.status).toBe("completed")
    expect(r.result).toBe(3)
    expect(attempts).toBe(3)
  })
})
