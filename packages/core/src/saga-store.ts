/**
 * Durable state for sagas. A saga is a multi-step workflow where each step can
 * have a compensating "undo". We persist the saga + every step (with the output
 * needed to undo it) so a half-finished saga can be resumed after a crash and
 * rolled back EXACTLY ONCE.
 */

export type SagaStatus =
  | "running" // forward pass in progress
  | "awaiting_step" // paused: a step needs approval (resume later)
  | "succeeded" // all steps committed
  | "compensating" // a step failed; rolling back
  | "compensated" // rolled back cleanly
  | "compensation_failed" // rollback got stuck — needs a human / DLQ

export type SagaStepStatus =
  | "pending"
  | "succeeded"
  | "compensated"
  | "compensation_failed"

export interface SagaRecord {
  sagaId: string
  name: string
  status: SagaStatus
  input: unknown
  /** Index of the next step to run on the forward pass. */
  currentStep: number
  /** The step whose failure triggered rollback (if any). */
  failedStep?: string
  error?: string
  createdAt: string
  updatedAt: string
}

export interface SagaStepRecord {
  sagaId: string
  stepIndex: number
  name: string
  status: SagaStepStatus
  /** The forward output — this is exactly what gets handed to undo(). */
  output?: unknown
  error?: string
}

export interface CreateSagaResult {
  /** True if WE created the row. False if it already existed. */
  created: boolean
  existing?: SagaRecord
}

/**
 * Storage backend for sagas. `createSaga` MUST be atomic so re-running the same
 * sagaId resumes the existing instance rather than starting a second one.
 */
export interface SagaStore {
  getSaga(sagaId: string): Promise<SagaRecord | undefined>
  createSaga(input: {
    sagaId: string
    name: string
    input: unknown
  }): Promise<CreateSagaResult>
  setSagaStatus(
    sagaId: string,
    status: SagaStatus,
    opts?: { error?: string; failedStep?: string },
  ): Promise<void>
  setCurrentStep(sagaId: string, currentStep: number): Promise<void>
  /** Upsert a step record (idempotent on sagaId + stepIndex). */
  recordStep(rec: SagaStepRecord): Promise<void>
  getSteps(sagaId: string): Promise<SagaStepRecord[]>
  listByStatus(status: SagaStatus, limit?: number): Promise<SagaRecord[]>
}

/**
 * In-memory saga store. Perfect for tests and local demos.
 * NOT durable — use PostgresSagaStore for anything real.
 */
export class InMemorySagaStore implements SagaStore {
  private readonly sagas = new Map<string, SagaRecord>()
  private readonly steps = new Map<string, SagaStepRecord>() // `${sagaId}#${stepIndex}`

  private stepKey(sagaId: string, stepIndex: number): string {
    return `${sagaId}#${stepIndex}`
  }

  async getSaga(sagaId: string): Promise<SagaRecord | undefined> {
    const r = this.sagas.get(sagaId)
    return r ? { ...r } : undefined
  }

  async createSaga(input: {
    sagaId: string
    name: string
    input: unknown
  }): Promise<CreateSagaResult> {
    const existing = this.sagas.get(input.sagaId)
    if (existing) return { created: false, existing: { ...existing } }
    const now = new Date().toISOString()
    this.sagas.set(input.sagaId, {
      sagaId: input.sagaId,
      name: input.name,
      status: "running",
      input: input.input,
      currentStep: 0,
      createdAt: now,
      updatedAt: now,
    })
    return { created: true }
  }

  async setSagaStatus(
    sagaId: string,
    status: SagaStatus,
    opts?: { error?: string; failedStep?: string },
  ): Promise<void> {
    const r = this.sagas.get(sagaId)
    if (!r) return
    r.status = status
    if (opts?.error !== undefined) r.error = opts.error
    if (opts?.failedStep !== undefined) r.failedStep = opts.failedStep
    r.updatedAt = new Date().toISOString()
  }

  async setCurrentStep(sagaId: string, currentStep: number): Promise<void> {
    const r = this.sagas.get(sagaId)
    if (!r) return
    r.currentStep = currentStep
    r.updatedAt = new Date().toISOString()
  }

  async recordStep(rec: SagaStepRecord): Promise<void> {
    this.steps.set(this.stepKey(rec.sagaId, rec.stepIndex), { ...rec })
  }

  async getSteps(sagaId: string): Promise<SagaStepRecord[]> {
    const out: SagaStepRecord[] = []
    for (const s of this.steps.values()) {
      if (s.sagaId === sagaId) out.push({ ...s })
    }
    out.sort((a, b) => a.stepIndex - b.stepIndex)
    return out
  }

  async listByStatus(status: SagaStatus, limit?: number): Promise<SagaRecord[]> {
    const out: SagaRecord[] = []
    for (const r of this.sagas.values()) {
      if (r.status === status) out.push({ ...r })
    }
    out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return typeof limit === "number" ? out.slice(0, limit) : out
  }
}
