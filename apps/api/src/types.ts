// Core data model for the Quorvel Cloud API.
// The action shape mirrors @quorvel/core's ActionRecord EXACTLY so HostedLedger
// can consume API responses as ActionRecord with no translation.

export type ActionStatus =
	| "pending"
	| "running"
	| "succeeded"
	| "failed"
	| "awaiting_approval"
	| "approved"
	| "rejected"
	| "denied"

export interface Org {
	id: string
	name: string
	plan: string
	createdAt: string
}

export interface ApiKeyRecord {
	id: string
	orgId: string
	keyHash: string
	keyPrefix: string
	name: string
	createdAt: string
	lastUsedAt?: string | null
	revokedAt?: string | null
}

/** Public action shape returned to clients — mirrors @quorvel/core ActionRecord. */
export interface ActionRecord {
	idempotencyKey: string
	scope: string | null
	tool: string
	args: unknown
	cost: number
	status: ActionStatus
	result?: unknown
	error?: string
	reason?: string
	attempts: number
	createdAt: string
}

/** Stored row: an ActionRecord plus server-side tenant + audit columns. */
export interface StoredAction extends ActionRecord {
	orgId: string
	updatedAt: string
}

export interface InsertPendingInput {
	idempotencyKey: string
	scope: string | null
	tool: string
	args?: unknown
	cost?: number
}

export interface InsertResult {
	inserted: boolean
	existing?: ActionRecord
}

/** Patch describing a single status transition (server-applied). */
export interface TransitionPatch {
	status: ActionStatus
	incrementAttempts?: boolean
	result?: unknown
	error?: string
	reason?: string
}

export interface StatsFilter {
	scope: string | null
	tool?: string
	since?: string | null
}

export interface Stats {
	count: number
	totalCost: number
}

export interface IssueKeyInput {
	orgName?: string
	plan?: string
}

export interface IssueKeyResult {
	orgId: string
	apiKey: string
	keyPrefix: string
}
