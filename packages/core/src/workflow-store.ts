/**
 * Durable state for workflows (Phase 4).
 *
 * A workflow is a long-running, durably-checkpointed function. We persist:
 *  - the run itself (status, input, result)
 *  - an ordered, append-only EVENT HISTORY (one event per ctx.* command)
 *  - a SIGNAL INBOX for external events that arrive before the workflow waits
 *
 * The history is what makes a crashed workflow resumable: on resume we replay
 * the function from the top and short-circuit every command that already has a
 * completed event, so committed work never runs twice.
 */

export type WorkflowStatus =
  | "running" // actively executing
  | "suspended" // parked on a durable timer or an external signal
  | "completed" // returned a result
  | "failed" // threw a non-retryable error

/** The kinds of durable commands a workflow can issue through `ctx`. */
export type WorkflowEventType = "step" | "sleep" | "signal" | "now" | "random"

export type WorkflowEventStatus = "pending" | "completed"

/**
 * A single entry in a workflow's history. `seq` is the deterministic position
 * of the command in the run; it is stable across replays as long as the
 * workflow code is deterministic.
 */
export interface WorkflowEvent {
  workflowId: string
  seq: number
  type: WorkflowEventType
  name: string
  status: WorkflowEventStatus
  /** The memoized result handed back on replay (steps/signals/now/random). */
  result?: unknown
  /** Epoch-ms the timer should fire. Set on `sleep` events only. */
  fireAt?: number
}

export interface WorkflowRunRecord {
  workflowId: string
  name: string
  status: WorkflowStatus
  input: unknown
  result?: unknown
  error?: string
  createdAt: string
  updatedAt: string
}

export interface CreateRunResult {
  /** True if WE created the row. False if it already existed. */
  created: boolean
  existing?: WorkflowRunRecord
}

/** An external signal sitting in the inbox, waiting to be consumed by a wait. */
export interface BufferedSignal {
  id: number
  workflowId: string
  name: string
  payload: unknown
  consumed: boolean
}

/**
 * Storage backend for workflows. `createRun` MUST be atomic so a duplicate
 * start resumes the existing instance rather than spawning a second one, and
 * `appendEvent` MUST be idempotent on (workflowId, seq) so a retried replay
 * never double-writes history.
 */
export interface WorkflowStore {
  getRun(workflowId: string): Promise<WorkflowRunRecord | undefined>
  createRun(input: {
    workflowId: string
    name: string
    input: unknown
  }): Promise<CreateRunResult>
  setRunStatus(
    workflowId: string,
    status: WorkflowStatus,
    opts?: { result?: unknown; error?: string },
  ): Promise<void>
  /** Append a new history event. Idempotent on (workflowId, seq). */
  appendEvent(event: WorkflowEvent): Promise<void>
  /** Mark a pending event completed (timer fired / signal delivered). */
  completeEvent(workflowId: string, seq: number, result?: unknown): Promise<void>
  /** Full history, ordered by seq ascending. */
  getEvents(workflowId: string): Promise<WorkflowEvent[]>
  /** Pending `sleep` events whose fireAt <= now (timers ready to fire). */
  getDueTimers(now: number, limit?: number): Promise<WorkflowEvent[]>
  /** Buffer an external signal that has no waiting consumer yet. */
  enqueueSignal(workflowId: string, name: string, payload: unknown): Promise<void>
  /** Atomically claim the earliest unconsumed signal of this name (FIFO). */
  consumeSignal(
    workflowId: string,
    name: string,
  ): Promise<BufferedSignal | undefined>
  listByStatus(status: WorkflowStatus, limit?: number): Promise<WorkflowRunRecord[]>
}

/**
 * In-memory workflow store. Perfect for tests and local demos.
 * NOT durable across processes — use PostgresWorkflowStore for anything real.
 */
export class InMemoryWorkflowStore implements WorkflowStore {
  private readonly runs = new Map<string, WorkflowRunRecord>()
  private readonly events = new Map<string, WorkflowEvent>() // `${workflowId}#${seq}`
  private readonly signals: BufferedSignal[] = []
  private signalSeq = 0

  private eventKey(workflowId: string, seq: number): string {
    return `${workflowId}#${seq}`
  }

  async getRun(workflowId: string): Promise<WorkflowRunRecord | undefined> {
    const r = this.runs.get(workflowId)
    return r ? { ...r } : undefined
  }

  async createRun(input: {
    workflowId: string
    name: string
    input: unknown
  }): Promise<CreateRunResult> {
    const existing = this.runs.get(input.workflowId)
    if (existing) return { created: false, existing: { ...existing } }
    const now = new Date().toISOString()
    this.runs.set(input.workflowId, {
      workflowId: input.workflowId,
      name: input.name,
      status: "running",
      input: input.input,
      createdAt: now,
      updatedAt: now,
    })
    return { created: true }
  }

  async setRunStatus(
    workflowId: string,
    status: WorkflowStatus,
    opts?: { result?: unknown; error?: string },
  ): Promise<void> {
    const r = this.runs.get(workflowId)
    if (!r) return
    r.status = status
    if (opts?.result !== undefined) r.result = opts.result
    if (opts?.error !== undefined) r.error = opts.error
    r.updatedAt = new Date().toISOString()
  }

  async appendEvent(event: WorkflowEvent): Promise<void> {
    const key = this.eventKey(event.workflowId, event.seq)
    if (this.events.has(key)) return // idempotent — never rewrite history
    this.events.set(key, { ...event })
  }

  async completeEvent(
    workflowId: string,
    seq: number,
    result?: unknown,
  ): Promise<void> {
    const e = this.events.get(this.eventKey(workflowId, seq))
    if (!e) return
    e.status = "completed"
    if (result !== undefined) e.result = result
  }

  async getEvents(workflowId: string): Promise<WorkflowEvent[]> {
    const out: WorkflowEvent[] = []
    for (const e of this.events.values()) {
      if (e.workflowId === workflowId) out.push({ ...e })
    }
    out.sort((a, b) => a.seq - b.seq)
    return out
  }

  async getDueTimers(now: number, limit?: number): Promise<WorkflowEvent[]> {
    const out: WorkflowEvent[] = []
    for (const e of this.events.values()) {
      if (
        e.type === "sleep" &&
        e.status === "pending" &&
        typeof e.fireAt === "number" &&
        e.fireAt <= now
      ) {
        out.push({ ...e })
      }
    }
    out.sort((a, b) => (a.fireAt ?? 0) - (b.fireAt ?? 0))
    return typeof limit === "number" ? out.slice(0, limit) : out
  }

  async enqueueSignal(
    workflowId: string,
    name: string,
    payload: unknown,
  ): Promise<void> {
    this.signals.push({
      id: this.signalSeq++,
      workflowId,
      name,
      payload,
      consumed: false,
    })
  }

  async consumeSignal(
    workflowId: string,
    name: string,
  ): Promise<BufferedSignal | undefined> {
    const s = this.signals.find(
      (x) => x.workflowId === workflowId && x.name === name && !x.consumed,
    )
    if (!s) return undefined
    s.consumed = true
    return { ...s }
  }

  async listByStatus(
    status: WorkflowStatus,
    limit?: number,
  ): Promise<WorkflowRunRecord[]> {
    const out: WorkflowRunRecord[] = []
    for (const r of this.runs.values()) {
      if (r.status === status) out.push({ ...r })
    }
    out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return typeof limit === "number" ? out.slice(0, limit) : out
  }
}
