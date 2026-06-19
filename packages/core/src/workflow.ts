import {
  WorkflowSuspended,
  WorkflowDeterminismError,
  WorkflowFailedError,
} from "./errors.js"
import type {
  WorkflowEvent,
  WorkflowRunRecord,
  WorkflowStore,
} from "./workflow-store.js"

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The handle a workflow body uses to do durable, replay-safe work. Every
 * method here is a CHECKPOINT: its result is persisted so a crash + resume
 * never re-executes committed work.
 *
 * Rule: a workflow MUST be deterministic except through this context. Read the
 * clock with `ctx.now()`, get randomness with `ctx.random()`, and do all I/O
 * inside `ctx.step()`. Do NOT branch on `Date.now()`, `Math.random()`, or
 * un-checkpointed I/O, or replay will diverge.
 */
export interface WorkflowContext<I = unknown> {
  readonly workflowId: string
  readonly input: I
  /**
   * Run a side-effecting activity exactly once across replays. The return value
   * is durably checkpointed; on resume it is returned from history without
   * re-running `fn`. A throwing step is NOT checkpointed, so resuming retries
   * it. `retries` adds in-process retries with exponential backoff.
   */
  step<T>(
    name: string,
    fn: () => Promise<T>,
    opts?: { retries?: number; backoffMs?: number },
  ): Promise<T>
  /** Durable timer: suspend the workflow for `ms`, surviving restarts. */
  sleep(name: string, ms: number): Promise<void>
  /** Suspend until an external signal of this name is delivered; returns it. */
  waitForSignal<T = unknown>(name: string): Promise<T>
  /** Deterministic, checkpointed wall-clock read (epoch ms). */
  now(): Promise<number>
  /** Deterministic, checkpointed random in [0, 1). */
  random(): Promise<number>
}

export type WorkflowFn<I = unknown, O = unknown> = (
  ctx: WorkflowContext<I>,
  input: I,
) => Promise<O>

export interface WorkflowDefinition<I = unknown, O = unknown> {
  name: string
  fn: WorkflowFn<I, O>
}

/** Define a workflow. Register it on a WorkflowEngine to run it. */
export function defineWorkflow<I = unknown, O = unknown>(
  name: string,
  fn: WorkflowFn<I, O>,
): WorkflowDefinition<I, O> {
  return { name, fn }
}

export interface WorkflowEngineOptions {
  store: WorkflowStore
  /**
   * Clock used for durable timers. Defaults to Date.now. Inject a controllable
   * clock in tests/demos so you don't have to wait real time for sleeps.
   */
  clock?: () => number
}

/**
 * Runs durable workflows by deterministic replay.
 *
 *  - `start`  : begin a new run (idempotent — a duplicate id resumes instead).
 *  - `resume` : re-drive an interrupted/suspended run from its history.
 *  - `signal` : deliver an external event; wakes a matching wait (or buffers).
 *  - `tick`   : fire all due durable timers and resume their workflows.
 *
 * A single "drive" replays the workflow body against persisted history: every
 * already-completed command returns instantly; the first not-yet-done command
 * either executes (steps) or suspends the run (sleep/signal).
 */
export class WorkflowEngine {
  private readonly registry = new Map<string, WorkflowDefinition>()
  private readonly store: WorkflowStore
  private readonly clock: () => number

  constructor(opts: WorkflowEngineOptions) {
    this.store = opts.store
    this.clock = opts.clock ?? (() => Date.now())
  }

  /** Register a workflow definition so the engine can run/resume it by name. */
  register(def: WorkflowDefinition<any, any>): this {
    this.registry.set(def.name, def as WorkflowDefinition)
    return this
  }

  /** Begin a workflow. Re-calling with the same workflowId resumes it. */
  async start<I>(
    name: string,
    opts: { workflowId: string; input?: I },
  ): Promise<WorkflowRunRecord> {
    const def = this.mustGet(name)
    const created = await this.store.createRun({
      workflowId: opts.workflowId,
      name,
      input: opts.input,
    })
    if (!created.created) return this.resume(opts.workflowId)
    return this.drive(def, opts.workflowId, opts.input)
  }

  /** Re-drive a suspended/interrupted run. Terminal runs are returned as-is. */
  async resume(workflowId: string): Promise<WorkflowRunRecord> {
    const run = await this.store.getRun(workflowId)
    if (!run) throw new Error(`Belay: no workflow run "${workflowId}"`)
    if (run.status === "completed") return run
    const def = this.mustGet(run.name)
    return this.drive(def, workflowId, run.input)
  }

  /**
   * Deliver an external signal. If the workflow is waiting on it, completes the
   * wait and resumes. Otherwise the signal is buffered until the workflow asks.
   */
  async signal(
    workflowId: string,
    name: string,
    payload: unknown,
  ): Promise<WorkflowRunRecord> {
    const events = await this.store.getEvents(workflowId)
    const waiting = events.find(
      (e) => e.type === "signal" && e.status === "pending" && e.name === name,
    )
    if (waiting) {
      await this.store.completeEvent(workflowId, waiting.seq, payload)
      return this.resume(workflowId)
    }
    await this.store.enqueueSignal(workflowId, name, payload)
    const run = await this.store.getRun(workflowId)
    if (!run) throw new Error(`Belay: no workflow run "${workflowId}"`)
    return run
  }

  /** Fire every timer due at `now` and resume the affected workflows. */
  async tick(now: number = this.clock()): Promise<number> {
    const due = await this.store.getDueTimers(now)
    const workflowIds = new Set<string>()
    for (const t of due) {
      await this.store.completeEvent(t.workflowId, t.seq)
      workflowIds.add(t.workflowId)
    }
    for (const id of workflowIds) await this.resume(id)
    return due.length
  }

  getRun(workflowId: string): Promise<WorkflowRunRecord | undefined> {
    return this.store.getRun(workflowId)
  }

  // -------------------------------------------------------------------------

  private mustGet(name: string): WorkflowDefinition {
    const def = this.registry.get(name)
    if (!def) throw new Error(`Belay: workflow "${name}" is not registered`)
    return def
  }

  private async drive(
    def: WorkflowDefinition,
    workflowId: string,
    input: unknown,
  ): Promise<WorkflowRunRecord> {
    await this.store.setRunStatus(workflowId, "running")
    const history = await this.store.getEvents(workflowId)
    const ctx = this.makeContext(workflowId, input, history)
    try {
      const result = await def.fn(ctx, input)
      await this.store.setRunStatus(workflowId, "completed", { result })
      return (await this.store.getRun(workflowId))!
    } catch (err) {
      if (err instanceof WorkflowSuspended) {
        await this.store.setRunStatus(workflowId, "suspended")
        return (await this.store.getRun(workflowId))!
      }
      // A determinism violation is a code bug, not a business failure — surface
      // it verbatim instead of wrapping it as a generic failure.
      if (err instanceof WorkflowDeterminismError) {
        await this.store.setRunStatus(workflowId, "failed", { error: err.message })
        throw err
      }
      const message = err instanceof Error ? err.message : String(err)
      await this.store.setRunStatus(workflowId, "failed", { error: message })
      throw new WorkflowFailedError(workflowId, message)
    }
  }

  private makeContext(
    workflowId: string,
    input: unknown,
    history: WorkflowEvent[],
  ): WorkflowContext {
    const bySeq = new Map<number, WorkflowEvent>()
    for (const e of history) bySeq.set(e.seq, e)
    let seq = 0
    const store = this.store
    const clock = this.clock

    const matchOrThrow = (
      existing: WorkflowEvent,
      type: WorkflowEvent["type"],
      name: string,
    ): void => {
      if (existing.type !== type || existing.name !== name) {
        throw new WorkflowDeterminismError(
          workflowId,
          existing.seq,
          `${existing.type}:${existing.name}`,
          `${type}:${name}`,
        )
      }
    }

    return {
      workflowId,
      input,

      async step<T>(
        name: string,
        fn: () => Promise<T>,
        opts?: { retries?: number; backoffMs?: number },
      ): Promise<T> {
        const s = seq++
        const existing = bySeq.get(s)
        if (existing) {
          matchOrThrow(existing, "step", name)
          if (existing.status === "completed") return existing.result as T
        }
        const retries = opts?.retries ?? 0
        const backoffMs = opts?.backoffMs ?? 100
        let lastErr: unknown
        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            const result = await fn()
            await store.appendEvent({
              workflowId,
              seq: s,
              type: "step",
              name,
              status: "completed",
              result,
            })
            return result
          } catch (e) {
            lastErr = e
            if (attempt < retries) await delay(backoffMs * 2 ** attempt)
          }
        }
        throw lastErr
      },

      async sleep(name: string, ms: number): Promise<void> {
        const s = seq++
        const existing = bySeq.get(s)
        if (existing) {
          matchOrThrow(existing, "sleep", name)
          if (existing.status === "completed") return
          throw new WorkflowSuspended() // timer still pending
        }
        await store.appendEvent({
          workflowId,
          seq: s,
          type: "sleep",
          name,
          status: "pending",
          fireAt: clock() + ms,
        })
        throw new WorkflowSuspended()
      },

      async waitForSignal<T = unknown>(name: string): Promise<T> {
        const s = seq++
        const existing = bySeq.get(s)
        if (existing) {
          matchOrThrow(existing, "signal", name)
          if (existing.status === "completed") return existing.result as T
          throw new WorkflowSuspended() // still waiting
        }
        // First time at this wait: maybe a signal was already buffered for it.
        const buffered = await store.consumeSignal(workflowId, name)
        if (buffered) {
          await store.appendEvent({
            workflowId,
            seq: s,
            type: "signal",
            name,
            status: "completed",
            result: buffered.payload,
          })
          return buffered.payload as T
        }
        await store.appendEvent({
          workflowId,
          seq: s,
          type: "signal",
          name,
          status: "pending",
        })
        throw new WorkflowSuspended()
      },

      async now(): Promise<number> {
        const s = seq++
        const existing = bySeq.get(s)
        if (existing) {
          matchOrThrow(existing, "now", "now")
          return existing.result as number
        }
        const value = clock()
        await store.appendEvent({
          workflowId,
          seq: s,
          type: "now",
          name: "now",
          status: "completed",
          result: value,
        })
        return value
      },

      async random(): Promise<number> {
        const s = seq++
        const existing = bySeq.get(s)
        if (existing) {
          matchOrThrow(existing, "random", "random")
          return existing.result as number
        }
        const value = Math.random()
        await store.appendEvent({
          workflowId,
          seq: s,
          type: "random",
          name: "random",
          status: "completed",
          result: value,
        })
        return value
      },
    }
  }
}
