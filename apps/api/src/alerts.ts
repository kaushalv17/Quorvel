// Alerting (Part 8). Pluggable transports (Slack / generic webhook / email via
// Resend) plus a rule set that turns domain events into alerts. The dispatcher
// is a bus subscriber. All transports take an injectable fetch for testing.
import type { DomainEvent } from "./events"
import type { AlertRuleRecord, AlertRuleStore, AlertTrigger } from "./alertRules"

export interface FetchResponse {
	ok: boolean
	status: number
	text(): Promise<string>
}
export interface FetchInit {
	method?: string
	headers?: Record<string, string>
	body?: string
}
export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponse>
export const defaultFetch: FetchLike = (url, init) =>
	(globalThis as any).fetch(url, init)

export type AlertLevel = "info" | "warning" | "critical"
export interface Alert {
	level: AlertLevel
	title: string
	body: string
	event: DomainEvent
}

export interface AlertTransport {
	name: string
	send(alert: Alert): Promise<void>
}

async function ensureOk(res: FetchResponse, what: string): Promise<void> {
	if (res.ok) return
	const text = await res.text().catch(() => "")
	throw new Error(`${what} failed: ${res.status} ${text}`)
}

export class SlackTransport implements AlertTransport {
	readonly name = "slack"
	constructor(
		private readonly webhookUrl: string,
		private readonly fetchImpl: FetchLike = defaultFetch,
	) {}
	async send(alert: Alert): Promise<void> {
		const res = await this.fetchImpl(this.webhookUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				text: `[${alert.level.toUpperCase()}] ${alert.title}\n${alert.body}`,
			}),
		})
		await ensureOk(res, "slack alert")
	}
}

export class WebhookTransport implements AlertTransport {
	readonly name = "webhook"
	constructor(
		private readonly url: string,
		private readonly fetchImpl: FetchLike = defaultFetch,
		private readonly headers: Record<string, string> = {},
	) {}
	async send(alert: Alert): Promise<void> {
		const res = await this.fetchImpl(this.url, {
			method: "POST",
			headers: { "content-type": "application/json", ...this.headers },
			body: JSON.stringify({
				level: alert.level,
				title: alert.title,
				body: alert.body,
				event: alert.event,
			}),
		})
		await ensureOk(res, "webhook alert")
	}
}

export class EmailTransport implements AlertTransport {
	readonly name = "email"
	constructor(
		private readonly opts: { apiKey: string; from: string; to: string },
		private readonly fetchImpl: FetchLike = defaultFetch,
	) {}
	async send(alert: Alert): Promise<void> {
		const res = await this.fetchImpl("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				authorization: `Bearer ${this.opts.apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				from: this.opts.from,
				to: this.opts.to,
				subject: alert.title,
				text: alert.body,
			}),
		})
		await ensureOk(res, "email alert")
	}
}

export interface AlertRule {
	id: string
	match(e: DomainEvent): boolean
	build(e: DomainEvent): Alert
}

export const DEFAULT_RULES: AlertRule[] = [
	{
		id: "approval-needed",
		match: (e) => e.status === "awaiting_approval",
		build: (e) => ({
			level: "warning",
			title: "Approval needed",
			body: `Agent ${e.scope ?? "(unscoped)"} requested ${e.tool} (cost ${e.cost}).`,
			event: e,
		}),
	},
	{
		id: "policy-denied",
		match: (e) => e.status === "denied",
		build: (e) => ({
			level: "critical",
			title: "Policy denied",
			body: `${e.tool} (${e.idempotencyKey}) denied${e.reason ? `: ${e.reason}` : ""}.`,
			event: e,
		}),
	},
	{
		id: "action-failed",
		match: (e) => e.status === "failed",
		build: (e) => ({
			level: "warning",
			title: "Action failed",
			body: `${e.tool} (${e.idempotencyKey}) failed${e.reason ? `: ${e.reason}` : ""}.`,
			event: e,
		}),
	},
]

const RULE_TRIGGER: Record<string, AlertTrigger> = {
    "approval-needed": "awaiting_approval",
    "policy-denied": "denied",
    "action-failed": "failed",
}

export class AlertDispatcher {
    constructor(
        private readonly transports: AlertTransport[],
        private readonly rules: AlertRule[] = DEFAULT_RULES,
        private readonly ruleStore?: AlertRuleStore,
    ) {}

    handle = async (e: DomainEvent): Promise<void> => {
        const orgRules = this.ruleStore ? await this.ruleStore.list(e.orgId) : null
        for (const rule of this.rules) {
            if (!rule.match(e)) continue
            const alert = rule.build(e)
            const targets = this.selectTransports(orgRules, rule.id, e.scope ?? null)
            if (targets.length === 0) continue
            await Promise.all(targets.map((t) => t.send(alert)))
        }
    }

    // Global-channels model: with no store (or an org that has configured no
    // rules) we preserve the original behavior and fan out to every transport.
    // Once an org has any rule, only the channels named by rules matching this
    // trigger + scope receive the alert -- so an org can opt specific triggers
    // in or out, optionally per agent scope.
    private selectTransports(
        orgRules: AlertRuleRecord[] | null,
        ruleId: string,
        scope: string | null,
    ): AlertTransport[] {
        if (orgRules === null || orgRules.length === 0) return this.transports
        const trigger = RULE_TRIGGER[ruleId]
        if (!trigger) return this.transports
        const matched = orgRules.filter(
            (r) => r.enabled && r.trigger === trigger && (r.scope === null || r.scope === scope),
        )
        if (matched.length === 0) return []
        const names = new Set(matched.flatMap((r) => r.channels))
        return this.transports.filter((t) => names.has(t.name))
    }
}