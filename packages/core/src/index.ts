// Phase 0 — idempotency
export { idempotencyKey, canonicalize } from "./idempotency.js"
export type { IdempotencyKeyInput } from "./idempotency.js"

// Phase 1 + 2 — exactly-once run, approvals
export {
  run,
  approve,
  reject,
  listPendingApprovals,
} from "./run.js"
export type { RunOptions } from "./run.js"

// Errors
export {
  DuplicateInFlightError,
  ApprovalRequiredError,
  PolicyDeniedError,
  ActionRejectedError,
  SagaAbortedError,
  SagaCompensationError,
  WorkflowFailedError,
  WorkflowDeterminismError,
} from "./errors.js"
export type { CompensationFailure } from "./errors.js"

// Ledger
export { InMemoryLedger } from "./ledger.js"
export type {
  LedgerStore,
  ActionRecord,
  ActionStatus,
  InsertPendingInput,
  InsertResult,
  StatsFilter,
  Stats,
} from "./ledger.js"

// Phase 2 — policy engine
export {
  evaluatePolicies,
  requireApprovalWhen,
  denyWhen,
  budget,
  rateLimit,
} from "./policy.js"
export type {
  Policy,
  PolicyDecision,
  ActionContext,
  BudgetOptions,
  RateLimitOptions,
} from "./policy.js"

// Phase 3 — saga / compensation (auto-rollback)
export { Saga, createSaga } from "./saga.js"
export type {
  SagaContext,
  StepDefinition,
  SagaResult,
  RunSagaOptions,
} from "./saga.js"
export { InMemorySagaStore } from "./saga-store.js"
export type {
  SagaStore,
  SagaRecord,
  SagaStepRecord,
  SagaStatus,
  SagaStepStatus,
  CreateSagaResult,
} from "./saga-store.js"

// Phase 4 — durable workflows & checkpointing
export { WorkflowEngine, defineWorkflow } from "./workflow.js"
export type {
  WorkflowContext,
  WorkflowFn,
  WorkflowDefinition,
  WorkflowEngineOptions,
} from "./workflow.js"
export { InMemoryWorkflowStore } from "./workflow-store.js"
export type {
  WorkflowStore,
  WorkflowRunRecord,
  WorkflowEvent,
  WorkflowEventType,
  WorkflowEventStatus,
  WorkflowStatus,
  CreateRunResult,
  BufferedSignal,
} from "./workflow-store.js"

// Durable backends
export { PostgresLedger } from "./postgres.js"
export { PostgresSagaStore } from "./postgres-saga.js"
export { PostgresWorkflowStore } from "./postgres-workflow.js"
