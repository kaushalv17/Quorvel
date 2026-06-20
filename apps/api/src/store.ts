// Storage seam. MemStore (tests/local) + PgStore (prod, in pgStore.ts).
// Action semantics mirror @belay/core's LedgerStore / InMemoryLedger so the
// hosted backend behaves identically to the in-process one.
import type {
	ActionRecord,
	ActionStatus,
	ApiKeyRecord,
	InsertPendingInput,
	InsertResult,
	Org,
	Stats,
	StatsFilter,
	StoredAction,
	TransitionPatch,
} from "./types"

/** Statuses that do NOT count toward budgets / rate limits. */
export const NON_COUNTING: ReadonlySet<ActionStatus> = new Set([
	"failed",
	"denied",
	"rejected",
])

export function toRecord(s: StoredAction): ActionRecord {
	const r: ActionRecord = {
		idempotencyKey: s.idempotencyKey,
		scope: s.scope,
		tool: s.tool,
		args: s.args,
		cost: s.cost,
		status: s.status,
		attempts: s.attempts,
		createdAt: s.createdAt,
	}
	if (s.result !== undefined) r.result = s.result
	if (s.error !== undefined) r.error = s.error
	if (s.reason !== undefined) r.reason = s.reason
	return r
}

export interface Store {
	insertOrg(org: Org): Promise<void>
	getOrg(orgId: string): Promise<Org | undefined>
	insertApiKey(rec: ApiKeyRecord): Promise<void>
	getApiKeyByHash(hash: string): Promise<ApiKeyRecord | undefined>

	getAction(orgId: string, key: string): Promise<StoredAction | undefined>
	insertPending(orgId: string, input: InsertPendingInput): Promise<InsertResult>
	applyTransition(
		orgId: string,
		key: string,
		patch: TransitionPatch,
	): Promise<void>
	listByStatus(
		orgId: string,
		status: ActionStatus,
		limit?: number,
	): Promise<ActionRecord[]>
	listRecent(orgId: string, limit?: number): Promise<ActionRecord[]>
	stats(orgId: string, filter: StatsFilter): Promise<Stats>
}

export class MemStore implements Store {
	private readonly orgs = new Map<string, Org>()
	private readonly keys = new Map<string, ApiKeyRecord>() // by keyHash
	private readonly actions = new Map<string, StoredAction>() // by `${orgId}\u0000${key}`

	private akey(orgId: string, key: string): string {
		return `${orgId}\u0000${key}`
	}

	async insertOrg(org: Org): Promise<void> {
		this.orgs.set(org.id, org)
	}

	async getOrg(orgId: string): Promise<Org | undefined> {
		return this.orgs.get(orgId)
	}

	async insertApiKey(rec: ApiKeyRecord): Promise<void> {
		this.keys.set(rec.keyHash, rec)
	}

	async getApiKeyByHash(hash: string): Promise<ApiKeyRecord | undefined> {
		return this.keys.get(hash)
	}

	async getAction(orgId: string, key: string): Promise<StoredAction | undefined> {
		return this.actions.get(this.akey(orgId, key))
	}

	async insertPending(
		orgId: string,
		input: InsertPendingInput,
	): Promise<InsertResult> {
		const existing = this.actions.get(this.akey(orgId, input.idempotencyKey))
		if (existing) return { inserted: false, existing: toRecord(existing) }
		const now = new Date().toISOString()
		const row: StoredAction = {
			orgId,
			idempotencyKey: input.idempotencyKey,
			scope: input.scope,
			tool: input.tool,
			args: input.args ?? null,
			cost: input.cost ?? 0,
			status: "pending",
			attempts: 0,
			createdAt: now,
			updatedAt: now,
		}
		this.actions.set(this.akey(orgId, input.idempotencyKey), row)
		return { inserted: true }
	}

	async applyTransition(
		orgId: string,
		key: string,
		patch: TransitionPatch,
	): Promise<void> {
		const row = this.actions.get(this.akey(orgId, key))
		if (!row) return // no-op if missing, matching InMemoryLedger/PostgresLedger
		row.status = patch.status
		if (patch.incrementAttempts) row.attempts += 1
		if (patch.result !== undefined) row.result = patch.result
		if (patch.error !== undefined) row.error = patch.error
		if (patch.reason !== undefined) row.reason = patch.reason
		row.updatedAt = new Date().toISOString()
	}

	async listByStatus(
		orgId: string,
		status: ActionStatus,
		limit?: number,
	): Promise<ActionRecord[]> {
		const out: StoredAction[] = []
		for (const r of this.actions.values()) {
			if (r.orgId === orgId && r.status === status) out.push(r)
		}
		out.sort((a: StoredAction, b: StoredAction) =>
			a.createdAt.localeCompare(b.createdAt),
		)
		const limited = typeof limit === "number" ? out.slice(0, limit) : out
		return limited.map(toRecord)
	}

	async listRecent(orgId: string, limit?: number): Promise<ActionRecord[]> {
		const out: StoredAction[] = []
		for (const r of this.actions.values()) {
			if (r.orgId === orgId) out.push(r)
		}
		// Most-recent first: order by updatedAt then createdAt, descending.
		out.sort((a: StoredAction, b: StoredAction) => {
			const byUpdated = b.updatedAt.localeCompare(a.updatedAt)
			return byUpdated !== 0 ? byUpdated : b.createdAt.localeCompare(a.createdAt)
		})
		const limited = out.slice(0, typeof limit === "number" ? limit : 100)
		return limited.map(toRecord)
	}

	async stats(orgId: string, filter: StatsFilter): Promise<Stats> {
		let count = 0
		let totalCost = 0
		for (const r of this.actions.values()) {
			if (r.orgId !== orgId) continue
			if (r.scope !== filter.scope) continue
			if (filter.tool && r.tool !== filter.tool) continue
			if (filter.since && r.createdAt < filter.since) continue
			if (NON_COUNTING.has(r.status)) continue
			count += 1
			totalCost += r.cost
		}
		return { count, totalCost }
	}
}
