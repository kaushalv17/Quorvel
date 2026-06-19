import type { Pool } from "pg"
import type {
  CreateSagaResult,
  SagaRecord,
  SagaStatus,
  SagaStepRecord,
  SagaStepStatus,
  SagaStore,
} from "./saga-store.js"

/**
 * A durable, Postgres-backed saga store. Pass a `pg` Pool.
 * Run migrations/003_saga.sql first.
 */
export class PostgresSagaStore implements SagaStore {
  constructor(private readonly pool: Pool) {}

  async getSaga(sagaId: string): Promise<SagaRecord | undefined> {
    const { rows } = await this.pool.query(
      `${SAGA_COLS} from belay_sagas where saga_id = $1`,
      [sagaId],
    )
    return rows.length ? mapSaga(rows[0]) : undefined
  }

  async createSaga(input: {
    sagaId: string
    name: string
    input: unknown
  }): Promise<CreateSagaResult> {
    // ON CONFLICT DO NOTHING => only the first caller for a sagaId creates it.
    const { rows } = await this.pool.query(
      `insert into belay_sagas (saga_id, name, input, status, current_step)
            values ($1, $2, $3, 'running', 0)
       on conflict (saga_id) do nothing
         returning saga_id`,
      [input.sagaId, input.name, JSON.stringify(input.input ?? null)],
    )
    if (rows.length > 0) return { created: true }
    return { created: false, existing: await this.getSaga(input.sagaId) }
  }

  async setSagaStatus(
    sagaId: string,
    status: SagaStatus,
    opts?: { error?: string; failedStep?: string },
  ): Promise<void> {
    await this.pool.query(
      `update belay_sagas
          set status = $2,
              error = coalesce($3, error),
              failed_step = coalesce($4, failed_step),
              updated_at = now()
        where saga_id = $1`,
      [sagaId, status, opts?.error ?? null, opts?.failedStep ?? null],
    )
  }

  async setCurrentStep(sagaId: string, currentStep: number): Promise<void> {
    await this.pool.query(
      `update belay_sagas set current_step = $2, updated_at = now() where saga_id = $1`,
      [sagaId, currentStep],
    )
  }

  async recordStep(rec: SagaStepRecord): Promise<void> {
    await this.pool.query(
      `insert into belay_saga_steps (saga_id, step_index, name, status, output, error)
            values ($1, $2, $3, $4, $5, $6)
       on conflict (saga_id, step_index)
         do update set status = excluded.status,
                       output = excluded.output,
                       error = excluded.error,
                       updated_at = now()`,
      [
        rec.sagaId,
        rec.stepIndex,
        rec.name,
        rec.status,
        JSON.stringify(rec.output ?? null),
        rec.error ?? null,
      ],
    )
  }

  async getSteps(sagaId: string): Promise<SagaStepRecord[]> {
    const { rows } = await this.pool.query(
      `select saga_id, step_index, name, status, output, error
         from belay_saga_steps where saga_id = $1 order by step_index asc`,
      [sagaId],
    )
    return rows.map(mapStep)
  }

  async listByStatus(status: SagaStatus, limit?: number): Promise<SagaRecord[]> {
    const { rows } = await this.pool.query(
      `${SAGA_COLS} from belay_sagas where status = $1 order by created_at asc limit $2`,
      [status, limit ?? 100],
    )
    return rows.map(mapSaga)
  }
}

const SAGA_COLS = `select saga_id, name, status, input, current_step, failed_step, error, created_at, updated_at`

function mapSaga(row: Record<string, unknown>): SagaRecord {
  return {
    sagaId: row.saga_id as string,
    name: row.name as string,
    status: row.status as SagaStatus,
    input: row.input,
    currentStep: Number(row.current_step ?? 0),
    failedStep: (row.failed_step as string | null) ?? undefined,
    error: (row.error as string | null) ?? undefined,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

function mapStep(row: Record<string, unknown>): SagaStepRecord {
  return {
    sagaId: row.saga_id as string,
    stepIndex: Number(row.step_index),
    name: row.name as string,
    status: row.status as SagaStepStatus,
    output: row.output ?? undefined,
    error: (row.error as string | null) ?? undefined,
  }
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value)
}
