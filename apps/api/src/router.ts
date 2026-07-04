// Framework-agnostic HTTP router. This is the SINGLE source of request handling:
// both the Fastify adapter (server.ts) and the HostedLedger round-trip tests
// call handleRequest, so the code under test is the code that runs.
import { ApiError, QuorvelCloudService } from "./service"
import type { ActionStatus } from "./types"
import { decodeCursor, type ActionCursor } from "./store"

/** The public API contract version. All public routes live under `/v1`. */
export const API_VERSION = "1"

export interface RawRequest {
    method: string
    path: string
    query: Record<string, string | undefined>
    body: any
    headers: Record<string, string | undefined>
    rawBody?: string
}

export interface RawResponse {
    status: number
    body?: unknown
}

const notFound: RawResponse = { status: 404, body: { error: "not found", code: "not_found" } }

/** Parse a `?limit=` value: a positive integer, capped at 1000. Rejects junk with 400. */
function parseLimit(raw: string | undefined): number | undefined {
    if (raw == null) return undefined
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
        throw new ApiError("limit must be an integer between 1 and 1000", 400, "invalid_query")
    }
    return n
}

/** Parse an optional ISO-8601 timestamp query value. Rejects junk with 400. */
function parseIsoParam(raw: string | undefined, field: string): string | null {
    if (raw == null || raw === "") return null
    if (Number.isNaN(Date.parse(raw))) {
        throw new ApiError(`${field} must be an ISO-8601 timestamp`, 400, "invalid_query")
    }
    return raw
}

/** Parse an opaque `?cursor=` token into a keyset cursor. Rejects junk with 400. */
function parseCursor(raw: string | undefined): ActionCursor | null {
	if (raw == null || raw === "") return null
	try {
		return decodeCursor(raw)
	} catch {
		throw new ApiError("cursor is malformed", 400, "invalid_query")
	}
}

async function resolveDashboardOrg(
    svc: QuorvelCloudService,
    dashboardSecret: string | undefined,
    req: RawRequest,
): Promise<{ orgId: string }> {
    if (!dashboardSecret || req.headers["x-dashboard-secret"] !== dashboardSecret) {
        throw new ApiError("invalid dashboard secret", 401, "unauthorized")
    }
    return svc.authenticateDashboard(
        req.headers["x-clerk-org-id"],
        req.headers["x-clerk-user-id"],
        req.headers["x-clerk-org-name"],
    )
}

export async function handleRequest(
    svc: QuorvelCloudService,
    req: RawRequest,
    dashboardSecret?: string,
): Promise<RawResponse> {
    try {
        if (req.method === "GET" && (req.path === "/" || req.path === "")) {
        	return { status: 200, body: { name: "Quorvel API", status: "ok", version: API_VERSION, docs: "https://docs.quorvel.tech" } }
        }
        if (req.method === "GET" && req.path === "/health") {
            return { status: 200, body: { ok: true, service: "belay-cloud-api", version: API_VERSION } }
        }

        if (req.method === "POST" && req.path === "/v1/webhooks/paddle") {
            try {
                return {
                    status: 200,
                    body: await svc.handlePaddleWebhook(
                        req.rawBody ?? "",
                        req.headers["paddle-signature"],
                    ),
                }
            } catch (e) {
                // A forged/invalid signature or malformed payload must be a 4xx
                // (never a 5xx, which Paddle would retry) and never mutates state.
                // Genuine internal errors still bubble to the 500 handler.
                const m = e instanceof Error ? e.message : "invalid webhook"
                if (m.includes("invalid paddle signature") || m.includes("invalid paddle payload")) {
                    return { status: 400, body: { error: m, code: "invalid_webhook" } }
                }
                throw e
            }
        }

        if (req.method === "POST" && req.path === "/v1/orgs/provision") {
            if (!dashboardSecret || req.headers["x-dashboard-secret"] !== dashboardSecret) {
                return { status: 401, body: { error: "dashboard secret required", code: "unauthorized" } }
            }
            const body = req.body ?? {}
            return {
                status: 200,
                body: await svc.provisionOrg({
                    ...body,
                    clerkOrgId: req.headers["x-clerk-org-id"] ?? body.clerkOrgId,
                    clerkUserId: req.headers["x-clerk-user-id"] ?? body.clerkUserId,
                    orgName: req.headers["x-clerk-org-name"] ?? body.orgName,
                }),
            }
        }

        const { orgId } =
            req.headers["x-dashboard-secret"] !== undefined
                ? await resolveDashboardOrg(svc, dashboardSecret, req)
                : await svc.authenticate(req.headers["authorization"])

        const actorId = req.headers["x-clerk-user-id"]

        const runOrgScoped = async (): Promise<RawResponse> => {
            if (req.path === "/v1/billing/checkout" && req.method === "POST") {
                return { status: 200, body: await svc.createCheckout(orgId, req.body ?? {}) }
            }

            if (req.path === "/v1/usage" && req.method === "GET") {
                return { status: 200, body: await svc.usage(orgId) }
            }

            if (req.path === "/v1/me" && req.method === "GET") {
                return { status: 200, body: await svc.me(orgId) }
            }

            if (req.path === "/v1/account/keys") {
                if (req.method === "GET") {
                    return { status: 200, body: await svc.listApiKeys(orgId) }
                }
                if (req.method === "POST") {
                    const b = req.body ?? {}
                    return {
                        status: 201,
                        body: await svc.createApiKey(orgId, {
                            name: b.name,
                            env: b.env,
                            scopes: b.scopes,
                            createdBy: actorId,
                        }),
                    }
                }
            }

            const keyMatch = req.path.match(/^\/v1\/account\/keys\/([^/]+)(\/rotate)?$/)
            if (keyMatch) {
                const id = decodeURIComponent(keyMatch[1])
                if (keyMatch[2] === "/rotate" && req.method === "POST") {
                    return { status: 201, body: await svc.rotateApiKey(orgId, id, actorId) }
                }
                if (!keyMatch[2] && (req.method === "DELETE" || req.method === "POST")) {
                    return { status: 200, body: await svc.revokeApiKey(orgId, id, actorId) }
                }
            }

            if (req.path === "/v1/audit" && req.method === "GET") {
                const limit = parseLimit(req.query.limit)
                return { status: 200, body: await svc.listAuditLog(orgId, limit) }
            }

            // Dead-letter queue: operator visibility + manual replay/discard.
            if (req.path === "/v1/dlq" && req.method === "GET") {
                const limit = parseLimit(req.query.limit)
                return { status: 200, body: await svc.listDeadLetters(orgId, limit) }
            }

            const dlqMatch = req.path.match(/^\/v1\/dlq\/([^/]+)(\/replay)?$/)
            if (dlqMatch) {
                const id = decodeURIComponent(dlqMatch[1])
                if (dlqMatch[2] === "/replay") {
                    if (req.method === "POST") {
                        return { status: 200, body: await svc.replayDeadLetter(orgId, id) }
                    }
                } else {
                    if (req.method === "GET") {
                        return { status: 200, body: await svc.getDeadLetter(orgId, id) }
                    }
                    if (req.method === "DELETE") {
                        return { status: 200, body: await svc.discardDeadLetter(orgId, id) }
                    }
                }
            }

            if (req.path === "/v1/alert-rules") {
                if (req.method === "GET") {
                    return { status: 200, body: await svc.listAlertRules(orgId) }
                }
                if (req.method === "POST") {
                    return {
                        status: 201,
                        body: await svc.createAlertRule(orgId, req.body ?? {}, actorId),
                    }
                }
            }

            const alertRuleMatch = req.path.match(/^\/v1\/alert-rules\/([^/]+)$/)
            if (alertRuleMatch) {
                const id = decodeURIComponent(alertRuleMatch[1])
                if (req.method === "POST") {
                    return {
                        status: 200,
                        body: await svc.updateAlertRule(orgId, id, req.body ?? {}, actorId),
                    }
                }
                if (req.method === "DELETE") {
                    return { status: 200, body: await svc.deleteAlertRule(orgId, id, actorId) }
                }
            }

            if (req.path === "/v1/billing/portal" && req.method === "POST") {
                return { status: 200, body: await svc.createBillingPortal(orgId) }
            }

            if (req.path === "/v1/onboarding/sample" && req.method === "POST") {
                return { status: 200, body: await svc.seedSampleData(orgId) }
            }

            if (req.path === "/v1/actions" && req.method === "POST") {
                return { status: 200, body: await svc.insertPending(orgId, req.body ?? {}) }
            }

            if (req.path === "/v1/actions" && req.method === "GET") {
                const status = req.query.status as ActionStatus | undefined
                const limit = parseLimit(req.query.limit)
                const rows = status
                    ? await svc.listByStatus(orgId, status, limit)
                    : await svc.listRecent(orgId, limit)
                return { status: 200, body: rows }
            }

            if (req.path === "/v1/actions/page" && req.method === "GET") {
				const status = req.query.status as ActionStatus | undefined
				const limit = parseLimit(req.query.limit)
				const cursor = parseCursor(req.query.cursor)
				return {
					status: 200,
					body: await svc.pageActions(orgId, { status, limit, cursor }),
				}
			}

			if (req.path === "/v1/events" && req.method === "GET") {
				const status = req.query.status as ActionStatus | undefined
				const limit = parseLimit(req.query.limit)
				return {
					status: 200,
					body: await svc.listEvents(orgId, {
						status,
						idempotencyKey: req.query.action,
						since: parseIsoParam(req.query.since, "since"),
						limit,
					}),
				}
			}

			if (req.path === "/v1/metrics" && req.method === "GET") {
				return {
					status: 200,
					body: await svc.metrics(orgId, {
						since: parseIsoParam(req.query.since, "since"),
						until: parseIsoParam(req.query.until, "until"),
					}),
				}
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

            const eventsMatch = req.path.match(/^\/v1\/actions\/([^/]+)\/events$/)
			if (eventsMatch && req.method === "GET") {
				const key = decodeURIComponent(eventsMatch[1])
				const timeline = await svc.runTimeline(orgId, key)
				return timeline ? { status: 200, body: timeline } : notFound
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
        }

        const idemKey = req.headers["idempotency-key"]
        if (idemKey && (req.method === "POST" || req.method === "DELETE")) {
            return await svc.withIdempotency(
                orgId,
                idemKey,
                { method: req.method, path: req.path, body: req.body ?? null },
                runOrgScoped,
            )
        }

        return await runOrgScoped()
    } catch (e) {
        if (e instanceof ApiError) {
            return { status: e.statusCode, body: { error: e.message, code: e.code } }
        }
        const msg = e instanceof Error ? e.message : "internal error"
        return { status: 500, body: { error: msg, code: "internal" } }
    }
}