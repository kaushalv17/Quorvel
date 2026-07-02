// Phase 4 (Observability): an append-only, per-run timeline of every action
// lifecycle event, so run history can be reconstructed and shown in the
// dashboard. Runs (belay_actions) only ever store their latest state; this log
// records the sequence of what happened.
//
// Persistence is wired as a bus subscriber (see wiring.ts) -- the same pattern
// as the usage-meter and alert dispatcher -- so it rides the resilient()
// isolation + dead-letter machinery for free. MemActionEventLog is used by
// tests/local; PgActionEventLog is the durable Postgres implementation.
//
// 4-B adds aggregate metrics computed from this same event stream via a single
// shared pure function (computeMetrics), so Mem and Pg cannot diverge.
import type { ActionStatus } from "./types"
import type { DomainEvent } from "./events"

/** DDL for the action_events timeline table. Applied via migration 0004. */
export const ACTION_EVENTS_SQL = `create table if not exists action_events (
    id               bigserial primary key,
    org_id           text not null,
    idempotency_key  text not null,
    type             text not null,
    status           text not null,
    attempt          int not null default 0,
    reason           text,
    error            text,
    at               timestamptz not null default now()
);
create index if not exists action_events_run_idx on action_events (org_id, idempotency_key, id);
create index if not exists action_events_recent_idx on action_events (org_id, at desc);`

export type ActionEventType = "created" | "transition"

export interface ActionEventInput {
    orgId: string
    idempotencyKey: string
    type: ActionEventType
    status: ActionStatus
    attempt?: number
    reason?: string | null
    error?: string | null
    /** Defaults to now() if omitted. */
    at?: string
}

export interface ActionEvent {
    id: string
    orgId: string
    idempotencyKey: string
    type: ActionEventType
    status: ActionStatus
    attempt: number
    reason: string | null
    error: string | null
    at: string
}

export interface ListEventsFilter {
    idempotencyKey?: string
    status?: ActionStatus
    since?: string | null
    limit?: number
}

export interface MetricsWindow {
    since?: string | null
    until?: string | null
}

export interface EventMetrics {
    since: string | null
    until: string | null
    runs: number
    events: number
    outcomes: { succeeded: number; failed: number; denied: number; rejected: number }
    terminalRuns: number
    errorRate: number
    latencyMs: { count: number; avg: number | null; p50: number | null; p95: number | null }
}

/** Minimal pg-client surface, so this module needs no direct dependency on pg. */
export interface ActionEventQueryable {
    query(
        text: string,
        params?: unknown[],
    ): Promise<{ rows: Array<Record<string, unknown>> }>
}

/** Storage seam for the action event timeline. */
export interface ActionEventLog {
    append(input: ActionEventInput): Promise<ActionEvent>
    /** One run events, oldest -> newest. */
    listByRun(orgId: string, idempotencyKey: string): Promise<ActionEvent[]>
    /** Cross-run recent feed, newest -> oldest. */
    listRecent(orgId: string, filter?: ListEventsFilter): Promise<ActionEvent[]>
    /** Aggregate metrics over a time window. */
    metrics(orgId: string, window?: MetricsWindow): Promise<EventMetrics>
}

export class MemActionEventLog implements ActionEventLog {
    private seq = 0
    private readonly events: ActionEvent[] = []

    async append(input: ActionEventInput): Promise<ActionEvent> {
        this.seq += 1
        const ev: ActionEvent = {
            id: String(this.seq),
            orgId: input.orgId,
            idempotencyKey: input.idempotencyKey,
            type: input.type,
            status: input.status,
            attempt: input.attempt ?? 0,
            reason: input.reason ?? null,
            error: input.error ?? null,
            at: input.at ?? new Date().toISOString(),
        }
        this.events.push(ev)
        return ev
    }

    async listByRun(orgId: string, idempotencyKey: string): Promise<ActionEvent[]> {
        return this.events
            .filter((e) => e.orgId === orgId && e.idempotencyKey === idempotencyKey)
            .sort((a, b) => Number(a.id) - Number(b.id))
    }

    async listRecent(orgId: string, filter: ListEventsFilter = {}): Promise<ActionEvent[]> {
        let out = this.events.filter((e) => e.orgId === orgId)
        if (filter.idempotencyKey) out = out.filter((e) => e.idempotencyKey === filter.idempotencyKey)
        if (filter.status) out = out.filter((e) => e.status === filter.status)
        if (filter.since) out = out.filter((e) => e.at >= filter.since!)
        out = out.sort((a, b) => Number(b.id) - Number(a.id))
        return out.slice(0, filter.limit ?? 100)
    }

    async metrics(orgId: string, window: MetricsWindow = {}): Promise<EventMetrics> {
        return computeMetrics(this.events.filter((e) => e.orgId === orgId), window)
    }
}

function toIso(v: unknown): string {
    return v instanceof Date ? v.toISOString() : String(v)
}

function mapEvent(row: Record<string, unknown>): ActionEvent {
    return {
        id: String(row.id),
        orgId: row.org_id as string,
        idempotencyKey: row.idempotency_key as string,
        type: row.type as ActionEventType,
        status: row.status as ActionStatus,
        attempt: Number(row.attempt ?? 0),
        reason: (row.reason as string | null) ?? null,
        error: (row.error as string | null) ?? null,
        at: toIso(row.at),
    }
}

/** Nearest-rank percentile over an ascending-sorted array. */
function percentile(sorted: number[], p: number): number | null {
    if (sorted.length === 0) return null
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
    return sorted[idx]
}

/**
 * Pure aggregator shared by Mem and Pg. Derives throughput, outcome mix, error
 * rate, and created-to-terminal latency percentiles from a list of events.
 */
export function computeMetrics(events: ActionEvent[], window: MetricsWindow = {}): EventMetrics {
    const since = window.since ?? null
    const until = window.until ?? null
    const inWindow = events.filter(
        (e) => (since == null || e.at >= since) && (until == null || e.at <= until),
    )
    const outcomes = { succeeded: 0, failed: 0, denied: 0, rejected: 0 }
    let runs = 0
    const createdAt = new Map<string, string>()
    const terminalAt = new Map<string, string>()
    for (const e of inWindow) {
        if (e.type === "created") {
            runs += 1
            const prev = createdAt.get(e.idempotencyKey)
            if (prev == null || e.at < prev) createdAt.set(e.idempotencyKey, e.at)
        }
        let isTerminal = false
        if (e.status === "succeeded") { outcomes.succeeded += 1; isTerminal = true }
        else if (e.status === "failed") { outcomes.failed += 1; isTerminal = true }
        else if (e.status === "denied") { outcomes.denied += 1; isTerminal = true }
        else if (e.status === "rejected") { outcomes.rejected += 1; isTerminal = true }
        if (isTerminal) {
            const prev = terminalAt.get(e.idempotencyKey)
            if (prev == null || e.at > prev) terminalAt.set(e.idempotencyKey, e.at)
        }
    }
    const terminalRuns = outcomes.succeeded + outcomes.failed + outcomes.denied + outcomes.rejected
    const errors = outcomes.failed + outcomes.denied + outcomes.rejected
    const errorRate = terminalRuns === 0 ? 0 : errors / terminalRuns
    const durations: number[] = []
    for (const [key, started] of createdAt) {
        const ended = terminalAt.get(key)
        if (ended == null) continue
        const ms = Date.parse(ended) - Date.parse(started)
        if (Number.isFinite(ms) && ms >= 0) durations.push(ms)
    }
    durations.sort((a, b) => a - b)
    const avg = durations.length
        ? Math.round(durations.reduce((sum, x) => sum + x, 0) / durations.length)
        : null
    return {
        since,
        until,
        runs,
        events: inWindow.length,
        outcomes,
        terminalRuns,
        errorRate,
        latencyMs: {
            count: durations.length,
            avg,
            p50: percentile(durations, 50),
            p95: percentile(durations, 95),
        },
    }
}

export class PgActionEventLog implements ActionEventLog {
    constructor(readonly pool: ActionEventQueryable) {}

    async append(input: ActionEventInput): Promise<ActionEvent> {
        const { rows } = await this.pool.query(
            `insert into action_events (org_id, idempotency_key, type, status, attempt, reason, error, at)
             values ($1,$2,$3,$4,$5,$6,$7, coalesce($8::timestamptz, now()))
             returning id, org_id, idempotency_key, type, status, attempt, reason, error, at`,
            [
                input.orgId,
                input.idempotencyKey,
                input.type,
                input.status,
                input.attempt ?? 0,
                input.reason ?? null,
                input.error ?? null,
                input.at ?? null,
            ],
        )
        return mapEvent(rows[0])
    }

    async listByRun(orgId: string, idempotencyKey: string): Promise<ActionEvent[]> {
        const { rows } = await this.pool.query(
            `select id, org_id, idempotency_key, type, status, attempt, reason, error, at
               from action_events where org_id=$1 and idempotency_key=$2 order by id asc`,
            [orgId, idempotencyKey],
        )
        return rows.map((r) => mapEvent(r))
    }

    async listRecent(orgId: string, filter: ListEventsFilter = {}): Promise<ActionEvent[]> {
        const { rows } = await this.pool.query(
            `select id, org_id, idempotency_key, type, status, attempt, reason, error, at
               from action_events
              where org_id=$1
                and ($2::text is null or idempotency_key=$2)
                and ($3::text is null or status=$3)
                and ($4::timestamptz is null or at >= $4)
              order by id desc
              limit $5`,
            [
                orgId,
                filter.idempotencyKey ?? null,
                filter.status ?? null,
                filter.since ?? null,
                filter.limit ?? 100,
            ],
        )
        return rows.map((r) => mapEvent(r))
    }

    async metrics(orgId: string, window: MetricsWindow = {}): Promise<EventMetrics> {
        const { rows } = await this.pool.query(
            `select id, org_id, idempotency_key, type, status, attempt, reason, error, at
               from action_events
              where org_id=$1
                and ($2::timestamptz is null or at >= $2)
                and ($3::timestamptz is null or at <= $3)
              order by id asc`,
            [orgId, window.since ?? null, window.until ?? null],
        )
        return computeMetrics(rows.map((r) => mapEvent(r)), window)
    }
}

/** Map a fanned-out DomainEvent onto a timeline event input. */
export function domainEventToActionEventInput(ev: DomainEvent): ActionEventInput {
    return {
        orgId: ev.orgId,
        idempotencyKey: ev.idempotencyKey,
        type: ev.type === "action.created" ? "created" : "transition",
        status: ev.status,
        reason: ev.reason ?? null,
        at: ev.at,
    }
}

/** A bus subscriber that persists every lifecycle event to the timeline. */
export function makeActionEventSink(
    log: ActionEventLog,
): (ev: DomainEvent) => Promise<void> {
    return async (ev) => {
        await log.append(domainEventToActionEventInput(ev))
    }
}