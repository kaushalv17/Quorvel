// Framework-agnostic HTTP router. This is the SINGLE source of request handling:
// both the Fastify adapter (server.ts) and the HostedLedger round-trip tests
// call handleRequest, so the code under test is the code that runs.
import { ApiError, BelayCloudService } from "./service"
import type { ActionStatus } from "./types"

export interface RawRequest {
	method: string
	path: string
	query: Record<string, string | undefined>
	body: any
	headers: Record<string, string | undefined>
}

export interface RawResponse {
	status: number
	body?: unknown
}

const notFound: RawResponse = { status: 404, body: { error: "not found", code: "not_found" } }

export async function handleRequest(
	svc: BelayCloudService,
	adminSecret: string | undefined,
	req: RawRequest,
): Promise<RawResponse> {
	try {
		if (req.method === "GET" && req.path === "/health") {
			return { status: 200, body: { ok: true, service: "belay-cloud-api" } }
		}

		// Bootstrap: mint an org API key. Guarded by admin secret, not a Bearer key.
		if (req.method === "POST" && req.path === "/v1/keys") {
			if (!adminSecret || req.headers["x-admin-secret"] !== adminSecret) {
				return { status: 401, body: { error: "admin secret required", code: "unauthorized" } }
			}
			return { status: 201, body: await svc.issueApiKey(req.body ?? {}) }
		}

		// Everything else under /v1 needs a valid Bearer key.
		const { orgId } = await svc.authenticate(req.headers["authorization"])

		if (req.path === "/v1/usage" && req.method === "GET") {
			return { status: 200, body: await svc.usage(orgId) }
		}

		if (req.path === "/v1/actions" && req.method === "POST") {
			return { status: 200, body: await svc.insertPending(orgId, req.body ?? {}) }
		}

		if (req.path === "/v1/actions" && req.method === "GET") {
			const status = req.query.status as ActionStatus | undefined
			const limit = req.query.limit != null ? Number(req.query.limit) : undefined
			// No status → recent timeline across statuses (powers the dashboard).
			const rows = status
				? await svc.listByStatus(orgId, status, limit)
				: await svc.listRecent(orgId, limit)
			return { status: 200, body: rows }
		}

		if (req.path === "/v1/stats" && req.method === "POST") {
			const b = req.body ?? {}
			return {
				status: 200,
				body: await svc.stats(orgId, {
					scope: b.scope ?? null,
					tool: b.tool,
					since: b.since ?? null,
				}),
			}
		}

		const m = req.path.match(/^\/v1\/actions\/([^/]+)(\/[a-z-]+)?$/)
		if (m) {
			const key = decodeURIComponent(m[1])
			const sub = m[2]
			const body = req.body ?? {}
			if (!sub && req.method === "GET") {
				const action = await svc.getAction(orgId, key)
				return action ? { status: 200, body: action } : notFound
			}
			if (req.method === "POST") {
				switch (sub) {
					case "/running":
						await svc.markRunning(orgId, key)
						return { status: 204 }
					case "/succeeded":
						await svc.markSucceeded(orgId, key, body.result)
						return { status: 204 }
					case "/failed":
						await svc.markFailed(orgId, key, body.error)
						return { status: 204 }
					case "/awaiting-approval":
						await svc.markAwaitingApproval(orgId, key, body.reason)
						return { status: 204 }
					case "/approved":
						await svc.markApproved(orgId, key)
						return { status: 204 }
					case "/rejected":
						await svc.markRejected(orgId, key, body.reason)
						return { status: 204 }
					case "/denied":
						await svc.markDenied(orgId, key, body.reason)
						return { status: 204 }
				}
			}
		}

		return notFound
	} catch (e) {
		if (e instanceof ApiError) {
			return { status: e.statusCode, body: { error: e.message, code: e.code } }
		}
		const msg = e instanceof Error ? e.message : "internal error"
		return { status: 500, body: { error: msg, code: "internal" } }
	}
}
