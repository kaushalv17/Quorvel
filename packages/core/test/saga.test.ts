import { describe, it, expect } from "vitest"
import { createSaga } from "../src/saga.js"
import { InMemoryLedger } from "../src/ledger.js"
import { InMemorySagaStore } from "../src/saga-store.js"
import { SagaAbortedError, SagaCompensationError } from "../src/errors.js"
import { requireApprovalWhen } from "../src/policy.js"
import { approve, listPendingApprovals } from "../src/run.js"

function setup() {
  return { ledger: new InMemoryLedger(), store: new InMemorySagaStore() }
}

describe("saga: happy path", () => {
  it("runs every step in order and returns their outputs", async () => {
    const { ledger, store } = setup()
    const log: string[] = []
    const saga = createSaga("checkout", { ledger, store })
      .step({ name: "charge", do: async () => { log.push("charge"); return { chargeId: "ch_1" } } })
      .step({ name: "reserve", do: async () => { log.push("reserve"); return { rsv: "r_1" } } })
      .step({ name: "ship", do: async () => { log.push("ship"); return { tracking: "T1" } } })

    const res = await saga.run({ sagaId: "s1" })
    expect(res.status).toBe("succeeded")
    expect(log).toEqual(["charge", "reserve", "ship"])
    expect(res.outputs.charge).toEqual({ chargeId: "ch_1" })
    expect(res.outputs.ship).toEqual({ tracking: "T1" })
  })
})

describe("saga: rollback", () => {
  it("compensates committed steps in REVERSE order, exactly once", async () => {
    const { ledger, store } = setup()
    const undos: string[] = []
    const saga = createSaga("checkout", { ledger, store })
      .step({ name: "charge", do: async () => ({ chargeId: "ch_1" }), undo: async () => { undos.push("charge") } })
      .step({ name: "reserve", do: async () => ({ rsv: "r_1" }), undo: async () => { undos.push("reserve") } })
      .step({ name: "ship", do: async () => { throw new Error("carrier down") } })

    await expect(saga.run({ sagaId: "s2" })).rejects.toBeInstanceOf(SagaAbortedError)
    expect(undos).toEqual(["reserve", "charge"])

    const rec = await store.getSaga("s2")
    expect(rec?.status).toBe("compensated")

    // Re-running an already-aborted saga must NOT compensate again.
    await expect(saga.run({ sagaId: "s2" })).rejects.toBeInstanceOf(SagaAbortedError)
    expect(undos).toEqual(["reserve", "charge"])
  })

  it("skips steps that have no undo", async () => {
    const { ledger, store } = setup()
    const undos: string[] = []
    const saga = createSaga("c", { ledger, store })
      .step({ name: "log", do: async () => ({ ok: true }) })
      .step({ name: "charge", do: async () => ({ chargeId: "ch" }), undo: async () => { undos.push("charge") } })
      .step({ name: "ship", do: async () => { throw new Error("boom") } })

    await expect(saga.run({ sagaId: "s6" })).rejects.toBeInstanceOf(SagaAbortedError)
    expect(undos).toEqual(["charge"])
  })
})

describe("saga: exactly-once forward", () => {
  it("does not re-run a committed step when the saga is resumed", async () => {
    const { ledger, store } = setup()
    let charges = 0
    const saga = createSaga("c", { ledger, store })
      .step({ name: "charge", do: async () => { charges += 1; return charges } })

    await saga.run({ sagaId: "s3" })
    await saga.run({ sagaId: "s3" })
    expect(charges).toBe(1)
  })
})

describe("saga: stuck rollback", () => {
  it("surfaces a stuck compensation, then clears it on resume", async () => {
    const { ledger, store } = setup()
    let failUndo = true
    let chargeUndos = 0
    const saga = createSaga("checkout", { ledger, store })
      .step({
        name: "charge",
        do: async () => ({ chargeId: "ch_1" }),
        compensationRetries: 0,
        undo: async () => {
          chargeUndos += 1
          if (failUndo) throw new Error("refund API 500")
        },
      })
      .step({ name: "ship", do: async () => { throw new Error("carrier down") } })

    await expect(saga.run({ sagaId: "s4" })).rejects.toBeInstanceOf(SagaCompensationError)
    expect((await store.getSaga("s4"))?.status).toBe("compensation_failed")

    // Fix the downstream issue and resume: the stuck refund retries + clears.
    failUndo = false
    await expect(saga.resume({ sagaId: "s4" })).rejects.toBeInstanceOf(SagaAbortedError)
    expect(chargeUndos).toBe(2)
    expect((await store.getSaga("s4"))?.status).toBe("compensated")
  })
})

describe("saga: approval pause", () => {
  it("pauses for approval WITHOUT rolling back, then resumes to success", async () => {
    const { ledger, store } = setup()
    const undos: string[] = []
    let shipped = false
    const saga = createSaga("checkout", { ledger, store })
      .step({ name: "charge", do: async () => ({ chargeId: "ch_1" }), undo: async () => { undos.push("charge") } })
      .step({
        name: "ship",
        cost: 500,
        policies: [requireApprovalWhen((c) => c.cost > 100, "ship over $100")],
        do: async () => { shipped = true; return { tracking: "T1" } },
      })

    await expect(saga.run({ sagaId: "s5" })).rejects.toThrow(/approval/i)
    expect(undos).toEqual([]) // NOT rolled back — the charge stands
    expect(shipped).toBe(false)
    expect((await store.getSaga("s5"))?.status).toBe("awaiting_step")

    const pending = await listPendingApprovals(ledger)
    expect(pending).toHaveLength(1)
    await approve(ledger, pending[0].idempotencyKey)

    const res = await saga.resume({ sagaId: "s5" })
    expect(res.status).toBe("succeeded")
    expect(shipped).toBe(true)
    expect(undos).toEqual([])
  })
})
