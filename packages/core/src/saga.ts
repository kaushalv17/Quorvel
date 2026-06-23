import { run } from "./run.js"
import type { LedgerStore } from "./ledger.js"
import type { Policy } from "./policy.js"
import {
  ApprovalRequiredError,
  DuplicateInFlightError,
  SagaAbortedError,
  SagaCompensationError,
  type CompensationFailure,
} from "./errors.js"
import type { SagaStore } from "./saga-store.js"

/** Everything a step's do()/undo() can see. */
export interface SagaContext {
  sagaId: string
  input: unknown
  scope: string
  /** Outputs of all previously-succeeded steps, keyed by step name. */
  outputs: Record<string, unknown>
}

export interface StepDefinition<TOut = unknown> {
  /** Unique, stable name for this step (used in the durable idempotency key). */
  name: string
  /** The forward action. Runs AT MOST ONCE, ever (durably deduped). */
  do: (ctx: SagaContext) => Promise<TOut>
  /**
   * The compensation. Given the exact output do() returned, undo its effect.
   * Quorvel guarantees at-most-once, but write it to tolerate a retry anyway.
   * Omit for steps with no side effect to undo.
   */
  undo?: (output: TOut, ctx: SagaContext) => Promise<void>
  /** Forward retries before the step is considered failed. Default 0. */
  retries?: number
  /** Compensation retries before rollback is considered stuck. Default 2. */
  compensationRetries?: number
  /** Cost for budget policies. Default 0. */
  cost?: number
  /** Policies evaluated before the forward action (approval, budget, ...). */
  policies?: Policy[]
}

export interface SagaResult {
  sagaId: string
  status: "succeeded"
  outputs: Record<string, unknown>
}

export interface RunSagaOptions {
  /** Stable id for this saga instance. Re-running with the same id resumes it. */
  sagaId: string
  input?: unknown
  /** Scope for budgets/idempotency. Defaults to sagaId. */
  scope?: string
}

interface SagaDeps {
  ledger: LedgerStore
  store: SagaStore
}

/**
 * A saga: an ordered list of steps, each with an optional compensation.
 *
 * Guarantees:
 *  - Each forward step runs AT MOST ONCE (via the durable ledger).
 *  - If any step fails, every previously-succeeded step is compensated in
 *    REVERSE order, each compensation also running AT MOST ONCE.
 *  - State is durable: a crash mid-flight is resumed by calling run()/resume()
 *    again with the same sagaId.
 *  - If a step needs human approval, the saga PAUSES (no rollback) and resumes
 *    after approval.
 *  - If a compensation itself keeps failing, the saga ends in
 *    `compensation_failed` and throws SagaCompensationError (route to a DLQ).
 */
export class Saga {
  private readonly steps: StepDefinition[] = []

  constructor(
    private readonly name: string,
    private readonly deps: SagaDeps,
  ) {}

  /** Add a step. Chainable. */
  step<TOut>(def: StepDefinition<TOut>): this {
    this.steps.push(def as StepDefinition)
    return this
  }

  /** Start (or resume) the saga. */
  async run(opts: RunSagaOptions): Promise<SagaResult> {
    const { store } = this.deps
    const scope = opts.scope ?? opts.sagaId
    const created = await store.createSaga({
      sagaId: opts.sagaId,
      name: this.name,
      input: opts.input,
    })

    // Existing saga: react to its persisted status (this is how resume works).
    if (!created.created && created.existing) {
      const s = created.existing
      const input = opts.input ?? s.input
      switch (s.status) {
        case "succeeded":
          return {
            sagaId: s.sagaId,
            status: "succeeded",
            outputs: await this.collectOutputs(s.sagaId),
          }
        case "compensated":
          return this.throwAborted(
            s.sagaId,
            s.failedStep ?? "?",
            s.error ?? "previously aborted",
          )
        case "compensating":
        case "compensation_failed":
          // Resume rollback — retries any stuck compensations.
          return this.compensate(
            s.sagaId,
            scope,
            s.failedStep ?? "?",
            s.error ?? "resumed rollback",
            input,
          )
        // "running" | "awaiting_step" -> (re)drive the forward pass below.
      }
      return this.forward(s.sagaId, scope, input)
    }

    return this.forward(opts.sagaId, scope, opts.input)
  }

  /** Resume a paused/interrupted saga. Alias for run() with the same id. */
  async resume(opts: RunSagaOptions): Promise<SagaResult> {
    return this.run(opts)
  }

  // -------------------------------------------------------------------------

  private async forward(
    sagaId: string,
    scope: string,
    input: unknown,
  ): Promise<SagaResult> {
    const { ledger, store } = this.deps
    await store.setSagaStatus(sagaId, "running")
    const outputs = await this.collectOutputs(sagaId)

    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i]
      const ctx: SagaContext = { sagaId, input, scope, outputs }
      try {
        // Each forward step rides the durable ledger => exactly-once execution.
        const out = await run<unknown>(ledger, {
          tool: `saga:${this.name}:${step.name}`,
          args: { sagaId, step: i },
          scope,
          cost: step.cost,
          retries: step.retries,
          policies: step.policies,
          execute: () => step.do(ctx),
        })
        outputs[step.name] = out
        await store.recordStep({
          sagaId,
          stepIndex: i,
          name: step.name,
          status: "succeeded",
          output: out,
        })
        await store.setCurrentStep(sagaId, i + 1)
      } catch (err) {
        // Approval / in-flight => PAUSE, do NOT roll back. Resume later.
        if (
          err instanceof ApprovalRequiredError ||
          err instanceof DuplicateInFlightError
        ) {
          await store.setCurrentStep(sagaId, i)
          await store.setSagaStatus(sagaId, "awaiting_step", {
            failedStep: step.name,
            error: err.message,
          })
          throw err
        }
        // Genuine failure (or hard policy deny) => roll back what we committed.
        const cause = err instanceof Error ? err.message : String(err)
        return this.compensate(sagaId, scope, step.name, cause, input)
      }
    }

    await store.setSagaStatus(sagaId, "succeeded")
    return { sagaId, status: "succeeded", outputs }
  }

  private async compensate(
    sagaId: string,
    scope: string,
    failedStep: string,
    cause: string,
    input: unknown,
  ): Promise<never> {
    const { ledger, store } = this.deps
    await store.setSagaStatus(sagaId, "compensating", { failedStep, error: cause })

    const steps = await store.getSteps(sagaId)
    const outputs = await this.collectOutputs(sagaId)
    const ctx: SagaContext = { sagaId, input, scope, outputs }

    // Undo only steps that committed (or whose previous undo got stuck), in
    // REVERSE order (LIFO) — the hallmark of the saga pattern.
    const toUndo = steps
      .filter(
        (s) => s.status === "succeeded" || s.status === "compensation_failed",
      )
      .sort((a, b) => b.stepIndex - a.stepIndex)

    const compensated: string[] = []
    const failures: CompensationFailure[] = []

    for (const rec of toUndo) {
      const def = this.steps[rec.stepIndex]
      if (!def?.undo) {
        // Nothing to undo; mark compensated so a resume skips it.
        await store.recordStep({ ...rec, status: "compensated" })
        compensated.push(rec.name)
        continue
      }
      try {
        // Compensation also rides the ledger => each undo runs AT MOST ONCE.
        await run<void>(ledger, {
          tool: `saga:${this.name}:${rec.name}:undo`,
          args: { sagaId, step: rec.stepIndex },
          scope,
          retries: def.compensationRetries ?? 2,
          execute: async () => {
            await def.undo!(rec.output, ctx)
          },
        })
        await store.recordStep({ ...rec, status: "compensated" })
        compensated.push(rec.name)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await store.recordStep({
          ...rec,
          status: "compensation_failed",
          error: msg,
        })
        failures.push({ step: rec.name, error: msg })
        // Keep going: undo as much as we safely can.
      }
    }

    if (failures.length > 0) {
      await store.setSagaStatus(sagaId, "compensation_failed", {
        failedStep,
        error: cause,
      })
      throw new SagaCompensationError(sagaId, failedStep, cause, failures)
    }

    await store.setSagaStatus(sagaId, "compensated", { failedStep, error: cause })
    throw new SagaAbortedError(sagaId, failedStep, cause, compensated)
  }

  /** Rebuild the outputs map from the durable step records. */
  private async collectOutputs(
    sagaId: string,
  ): Promise<Record<string, unknown>> {
    const steps = await this.deps.store.getSteps(sagaId)
    const out: Record<string, unknown> = {}
    for (const s of steps) {
      if (s.status !== "pending") out[s.name] = s.output
    }
    return out
  }

  private async throwAborted(
    sagaId: string,
    failedStep: string,
    cause: string,
  ): Promise<never> {
    const steps = await this.deps.store.getSteps(sagaId)
    const compensated = steps
      .filter((s) => s.status === "compensated")
      .map((s) => s.name)
    throw new SagaAbortedError(sagaId, failedStep, cause, compensated)
  }
}

/** Create a saga. Chain `.step(...)` calls, then `.run({ sagaId })`. */
export function createSaga(
  name: string,
  deps: SagaDeps,
): Saga {
  return new Saga(name, deps)
}
