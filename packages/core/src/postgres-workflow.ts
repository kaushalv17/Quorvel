import type { Pool } from "pg"
import type {
  BufferedSignal,
  CreateRunResult,
  WorkflowEvent,
  WorkflowRunRecord,
  WorkflowStatus,
  WorkflowStore,
} from "./workflow-store.js"

/**
 * A durable, Postgres-backed workflow store. Pass a `pg` Pool.
 * Run migrations/004_workflow.sql first.
 *
 * Durability notes:
 *  - createRun uses ON CONFLICT DO NOTHING so only the first starter wins.
 *  - appendEvent uses ON CONFLICT DO NOTHING so a retried replay never
 *    rewrites history (events are immutable once written).
 *  - consumeSignal claims the earliest inbox row with FOR UPDATE SKIP LOCKED so
 *    concurrent workers never hand the same signal to two waits.
 */
export class PostgresWorkflowStore implements WorkflowStore {
  constructor(private readonly pool: Pool) {}

  async getRun(workflowId: string): Promise<WorkflowRunRecord | undefined> {
    const { rows } = await this.pool.query(
      `${RUN_COLS} from belay_workflows where workflow_id = $1`,
      [workflowId],
    )
    return rows.length ? mapRun(rows[0]) : undefined
  }

  async createRun(input: {
    workflowId: string
    name: string
    input: unknown
  }): Promise<CreateRunResult> {
    const { rows } = await this.pool.query(
      `insert into belay_workflows (workflow_id, name, input, status)
            values ($1, $2, $3, 'running')
         on conflict (workflow_id) do nothing
         returning workflow_id`,
      [input.workflowId, input.name, JSON.stringify(input.input ?? null)],
    )
    if (rows.length > 0) return { created: true }
    return { created: false, existing: await this.getRun(input.workflowId) }
  }

  async setRunStatus(
    workflowId: string,
    status: WorkflowStatus,
    opts?: { result?: unknown; error?: string },
  ): Promise<void> {
    await this.pool.query(
      `update belay_workflows
          set status = $2,
              result = coalesce($3, result),
              error = coalesce($4, error),
              updated_at = now()
        where workflow_id = $1`,
      [
        workflowId,
        status,
        opts?.result !== undefined ? JSON.stringify(opts.result) : null,
        opts?.error ?? null,
      ],
    )
  }

  async appendEvent(event: WorkflowEvent): Promise<void> {
    await this.pool.query(
      `insert into belay_workflow_events
            (workflow_id, seq, type, name, status, result, fire_at)
            values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (workflow_id, seq) do nothing`,
      [
        event.workflowId,
        event.seq,
        event.type,
        event.name,
        event.status,
        event.result !== undefined ? JSON.stringify(event.result) : null,
        event.fireAt ?? null,
      ],
    )
  }

  async completeEvent(
    workflowId: string,
    seq: number,
    result?: unknown,
  ): Promise<void> {
    await this.pool.query(
      `update belay_workflow_events
          set status = 'completed',
              result = coalesce($3, result),
              updated_at = now()
        where workflow_id = $1 and seq = $2`,
      [workflowId, seq, result !== undefined ? JSON.stringify(result) : null],
    )
  }

  async getEvents(workflowId: string): Promise<WorkflowEvent[]> {
    const { rows } = await this.pool.query(
      `select workflow_id, seq, type, name, status, result, fire_at
         from belay_workflow_events
        where workflow_id = $1
        order by seq asc`,
      [workflowId],
    )
    return rows.map(mapEvent)
  }

  async getDueTimers(now: number, limit?: number): Promise<WorkflowEvent[]> {
    const { rows } = await this.pool.query(
      `select workflow_id, seq, type, name, status, result, fire_at
         from belay_workflow_events
        where type = 'sleep' and status = 'pending' and fire_at <= $1
        order by fire_at asc
        limit $2`,
      [now, limit ?? 100],
    )
    return rows.map(mapEvent)
  }

  async enqueueSignal(
    workflowId: string,
    name: string,
    payload: unknown,
  ): Promise<void> {
    await this.pool.query(
      `insert into belay_workflow_signals (workflow_id, name, payload)
            values ($1, $2, $3)`,
      [workflowId, name, JSON.stringify(payload ?? null)],
    )
  }

  async consumeSignal(
    workflowId: string,
    name: string,
  ): Promise<BufferedSignal | undefined> {
    const { rows } = await this.pool.query(
      `update belay_workflow_signals
          set consumed = true
        where id = (
          select id from belay_workflow_signals
           where workflow_id = $1 and name = $2 and consumed = false
           order by id asc
           limit 1
           for update skip locked
        )
        returning id, workflow_id, name, payload, consumed`,
      [workflowId, name],
    )
    if (!rows.length) return undefined
    const r = rows[0]
    return {
      id: Number(r.id),
      workflowId: r.workflow_id,
      name: r.name,
      payload: r.payload,
      consumed: r.consumed,
    }
  }

  async listByStatus(
    status: WorkflowStatus,
    limit?: number,
  ): Promise<WorkflowRunRecord[]> {
    const { rows } = await this.pool.query(
      `${RUN_COLS} from belay_workflows where status = $1 order by created_at asc limit $2`,
      [status, limit ?? 100],
    )
    return rows.map(mapRun)
  }
}

const RUN_COLS = `select workflow_id, name, status, input, result, error, created_at, updated_at`

function mapRun(row: Record<string, unknown>): WorkflowRunRecord {
  return {
    workflowId: row.workflow_id as string,
    name: row.name as string,
    status: row.status as WorkflowStatus,
    input: row.input,
    result: row.result ?? undefined,
    error: (row.error as string | null) ?? undefined,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

function mapEvent(row: Record<string, unknown>): WorkflowEvent {
  return {
    workflowId: row.workflow_id as string,
    seq: Number(row.seq),
    type: row.type as WorkflowEvent["type"],
    name: row.name as string,
    status: row.status as WorkflowEvent["status"],
    result: row.result ?? undefined,
    fireAt: row.fire_at != null ? Number(row.fire_at) : undefined,
  }
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value)
}
