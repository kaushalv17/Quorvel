// Framework-agnostic business logic. Talks only to a Store. The action methods
// are a 1:1 mapping of @quorvel/core's LedgerStore, scoped per org.
//
// Two optional collaborators (both no-ops when absent, so the LedgerStore
// contract is unchanged):
//   - bus:     publishes DomainEvents after each write (Parts 7–9 plumbing)
//   - limiter: gates insertPending on plan quota (Part 9 billing)
import { actionCreated, actionTransition } from "./events"
import { currentPeriod, planLimit, type UsageLimiter, type UsageSnapshot } from "./billing"
import { generateApiKey, hashApiKey, keyPrefix, newId } from "./keys"
import { toRecord, type Store } from "./store"
import type { PaddleBilling, CheckoutResult, WebhookResult } from "./paddle"
import type { EventBus } from "./bus"
import type {
	ActionRecord,
	ActionStatus,
	InsertPendingInput,
	InsertResult,
	IssueKeyInput,
	IssueKeyResult,
	Stats,
	StatsFilter,
	TransitionPatch,
} from "./types"

export class ApiError extends Error {
	constructor(
		message: string,
		readonly statusCode: number,
		readonly code: string,
	) {
		super(message)
		this.name = "ApiError"
	}
}

export const authError = (msg = "unauthorized") => new ApiError(msg, 401, "unauthorized")
export const badRequest = (msg: string) => new ApiError(msg, 400, "bad_request")
export const quotaError = (msg: string) => new ApiError(msg, 402, "quota_exceeded")

export interface ServiceDeps {
	bus?: EventBus
	limiter?: UsageLimiter
	billing?: PaddleBilling
}

export class QuorvelCloudService {
	private readonly bus?: EventBus
	private readonly limiter?: UsageLimiter
	private readonly billing?: PaddleBilling

	constructor(private readonly store: Store, deps: ServiceDeps = {}) {
		this.bus = deps.bus
		this.limiter = deps.limiter
		this.billing = deps.billing
	}

	async issueApiKey(input: IssueKeyInput): Promise<IssueKeyResult> {
		const now = new Date().toISOString()
		const orgId = newId("org")
		await this.store.insertOrg({
			id: orgId,
			name: input.orgName ?? "org",
			plan: input.plan ?? "free",
			createdAt: now,
		})
		const apiKey = generateApiKey("live")
		await this.store.insertApiKey({
			id: newId("key"),
			orgId,
			keyHash: hashApiKey(apiKey),
			keyPrefix: keyPrefix(apiKey),
			name: "default",
			createdAt: now,
		})
		return { orgId, apiKey, keyPrefix: keyPrefix(apiKey) }
	}

	async authenticate(authHeader: string | undefined): Promise<{ orgId: string }> {
		if (!authHeader) throw authError("missing Authorization header")
		const token = authHeader.startsWith("Bearer ")
			? authHeader.slice("Bearer ".length).trim()
			: authHeader.trim()
		if (!token) throw authError("empty API key")
		const rec = await this.store.getApiKeyByHash(hashApiKey(token))
		if (!rec) throw authError("invalid API key")
		if (rec.revokedAt) throw authError("API key revoked")
		return { orgId: rec.orgId }
	}

	// --- LedgerStore surface (org-scoped) ---

	async insertPending(orgId: string, input: InsertPendingInput): Promise<InsertResult> {
		if (!input || typeof input.idempotencyKey !== "string" || !input.tool) {
			throw badRequest("idempotencyKey and tool are required")
		}
		if (this.limiter) {
			const verdict = await this.limiter.check(orgId)
			if (!verdict.allowed) throw quotaError(verdict.reason ?? "quota exceeded")
		}
		const normalized: InsertPendingInput = {
			idempotencyKey: input.idempotencyKey,
			scope: input.scope ?? null,
			tool: input.tool,
			args: input.args,
			cost: input.cost,
		}
		const res = await this.store.insertPending(orgId, normalized)
		if (res.inserted && this.bus) {
			const row = await this.store.getAction(orgId, normalized.idempotencyKey)
			if (row) await this.bus.publish(actionCreated(row))
		}
		return res
	}

	async getAction(orgId: string, key: string): Promise<ActionRecord | undefined> {
		const row = await this.store.getAction(orgId, key)
		return row ? toRecord(row) : undefined
	}

	private async transition(orgId: string, key: string, patch: TransitionPatch): Promise<void> {
		await this.store.applyTransition(orgId, key, patch)
		if (this.bus) {
			const row = await this.store.getAction(orgId, key)
			if (row) await this.bus.publish(actionTransition(row))
		}
	}

	markRunning(orgId: string, key: string): Promise<void> {
		return this.transition(orgId, key, { status: "running", incrementAttempts: true })
	}
	markSucceeded(orgId: string, key: string, result: unknown): Promise<void> {
		return this.transition(orgId, key, { status: "succeeded", result: result ?? null })
	}
	markFailed(orgId: string, key: string, error: string): Promise<void> {
		return this.transition(orgId, key, { status: "failed", error: error ?? "" })
	}
	markAwaitingApproval(orgId: string, key: string, reason: string): Promise<void> {
		return this.transition(orgId, key, { status: "awaiting_approval", reason: reason ?? "" })
	}
	markApproved(orgId: string, key: string): Promise<void> {
		return this.transition(orgId, key, { status: "approved" })
	}
	markRejected(orgId: string, key: string, reason: string): Promise<void> {
		return this.transition(orgId, key, { status: "rejected", reason: reason ?? "" })
	}
	markDenied(orgId: string, key: string, reason: string): Promise<void> {
		return this.transition(orgId, key, { status: "denied", reason: reason ?? "" })
	}

	listByStatus(orgId: string, status: ActionStatus, limit?: number): Promise<ActionRecord[]> {
		return this.store.listByStatus(orgId, status, limit)
	}

	listRecent(orgId: string, limit?: number): Promise<ActionRecord[]> {
		return this.store.listRecent(orgId, limit)
	}

	stats(orgId: string, filter: StatsFilter): Promise<Stats> {
		return this.store.stats(orgId, {
			scope: filter.scope ?? null,
			tool: filter.tool,
			since: filter.since ?? null,
		})
	}

	async createCheckout(
		orgId: string,
		input: { plan?: string },
	): Promise<CheckoutResult> {
		if (!this.billing) throw badRequest("billing is not configured")
		const plan = input?.plan
		if (plan !== "pro" && plan !== "scale") {
			throw badRequest("plan must be 'pro' or 'scale'")
		}
		return this.billing.createCheckout(orgId, plan)
	}

	async handlePaddleWebhook(
		rawBody: string,
		signature: string | undefined,
	): Promise<WebhookResult> {
		if (!this.billing) throw badRequest("billing is not configured")
		try {
			return await this.billing.handleWebhook(rawBody, signature, this.store)
		} catch (e) {
			const msg = e instanceof Error ? e.message : "webhook error"
			if (msg.includes("signature") || msg.includes("payload")) {
				throw authError(msg)
			}
			throw e
		}
	}

	async usage(orgId: string): Promise<UsageSnapshot> {
		if (this.limiter) return this.limiter.usage(orgId)
		const limit = planLimit("free")
		return { plan: "free", period: currentPeriod(), used: 0, limit, remaining: limit }
	}
}
