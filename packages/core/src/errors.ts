/** Errors Belay throws so callers can react precisely (catch by type). */

export class DuplicateInFlightError extends Error {
  readonly key: string
  constructor(key: string) {
    super(`Belay: an action with this idempotency key is already in flight (${key})`)
    this.name = "DuplicateInFlightError"
    this.key = key
  }
}

export class ApprovalRequiredError extends Error {
  readonly key: string
  readonly reason: string
  constructor(key: string, reason: string) {
    super(`Belay: action requires approval — ${reason} [${key}]`)
    this.name = "ApprovalRequiredError"
    this.key = key
    this.reason = reason
  }
}

export class PolicyDeniedError extends Error {
  readonly key: string
  readonly reason: string
  constructor(key: string, reason: string) {
    super(`Belay: action denied by policy — ${reason} [${key}]`)
    this.name = "PolicyDeniedError"
    this.key = key
    this.reason = reason
  }
}

export class ActionRejectedError extends Error {
  readonly key: string
  readonly reason: string | null
  constructor(key: string, reason: string | null) {
    super(`Belay: action was rejected${reason ? ` — ${reason}` : ""} [${key}]`)
    this.name = "ActionRejectedError"
    this.key = key
    this.reason = reason
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — Saga / Compensation
// ---------------------------------------------------------------------------

/** Details about a single compensation that could not be completed. */
export interface CompensationFailure {
  step: string
  error: string
}

/**
 * Thrown when a saga step failed but Belay successfully rolled back every
 * previously-committed step. The system is in a clean, consistent state — the
 * business operation simply did not happen.
 */
export class SagaAbortedError extends Error {
  readonly sagaId: string
  readonly failedStep: string
  readonly cause: string
  /** Names of the steps that were rolled back, in the order they were undone. */
  readonly compensated: string[]
  constructor(
    sagaId: string,
    failedStep: string,
    cause: string,
    compensated: string[],
  ) {
    super(
      `Belay: saga "${sagaId}" aborted at step "${failedStep}" — ${cause}. ` +
        `Rolled back ${compensated.length} step(s).`,
    )
    this.name = "SagaAbortedError"
    this.sagaId = sagaId
    this.failedStep = failedStep
    this.cause = cause
    this.compensated = compensated
  }
}

/**
 * Thrown when rollback itself failed: one or more compensations could not be
 * completed even after retries. The saga is left in `compensation_failed` and
 * SHOULD be routed to a dead-letter queue / on-call human. This is the
 * "stuck money" case you must never silently swallow. Call resume() once the
 * downstream issue is fixed to retry the stuck compensations.
 */
export class SagaCompensationError extends Error {
  readonly sagaId: string
  readonly failedStep: string
  readonly cause: string
  readonly failures: CompensationFailure[]
  constructor(
    sagaId: string,
    failedStep: string,
    cause: string,
    failures: CompensationFailure[],
  ) {
    super(
      `Belay: saga "${sagaId}" FAILED TO COMPENSATE after aborting at "${failedStep}". ` +
        `${failures.length} compensation(s) stuck: ${failures
          .map((f) => f.step)
          .join(", ")}. Needs manual intervention.`,
    )
    this.name = "SagaCompensationError"
    this.sagaId = sagaId
    this.failedStep = failedStep
    this.cause = cause
    this.failures = failures
  }
}

// ---------------------------------------------------------------------------
// Phase 4 — Durable Workflows
// ---------------------------------------------------------------------------

/**
 * Internal control-flow signal: the workflow has parked on a durable timer or
 * an external signal. The engine catches this to persist state and return.
 *
 * Do NOT catch this in workflow code (e.g. a broad try/catch around
 * ctx.sleep / ctx.waitForSignal) — swallowing it breaks durable suspension.
 */
export class WorkflowSuspended extends Error {
  constructor() {
    super("Belay: workflow suspended (awaiting a durable timer or signal)")
    this.name = "WorkflowSuspended"
  }
}

/**
 * Thrown when a workflow body throws a non-retryable error. The run is left in
 * `failed`; fix the underlying issue and call resume() to continue from the
 * last durable checkpoint (committed steps are never re-run).
 */
export class WorkflowFailedError extends Error {
  readonly workflowId: string
  readonly cause: string
  constructor(workflowId: string, cause: string) {
    super(`Belay: workflow "${workflowId}" failed — ${cause}`)
    this.name = "WorkflowFailedError"
    this.workflowId = workflowId
    this.cause = cause
  }
}

/**
 * Thrown during replay when the workflow code issues a different command than
 * the one recorded in history at the same position. This means the workflow
 * was changed in a backward-incompatible way, or it used non-deterministic
 * logic outside `ctx` (e.g. raw Date.now()/Math.random()/un-checkpointed I/O).
 */
export class WorkflowDeterminismError extends Error {
  readonly workflowId: string
  readonly seq: number
  readonly expected: string
  readonly actual: string
  constructor(
    workflowId: string,
    seq: number,
    expected: string,
    actual: string,
  ) {
    super(
      `Belay: non-deterministic workflow "${workflowId}" at step ${seq}: ` +
        `history recorded "${expected}" but the code issued "${actual}". ` +
        `The workflow changed incompatibly or used logic outside ctx.`,
    )
    this.name = "WorkflowDeterminismError"
    this.workflowId = workflowId
    this.seq = seq
    this.expected = expected
    this.actual = actual
  }
}
