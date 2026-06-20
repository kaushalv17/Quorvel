// Domain events emitted by the service and fanned out via the bus to billing
// meters and alert transports.
import type { ActionStatus, StoredAction } from "./types"

export interface DomainEvent {
	type: "action.created" | "action.transition"
	orgId: string
	idempotencyKey: string
	tool: string
	scope: string | null
	cost: number
	status: ActionStatus
	reason?: string
	at: string
}

function base(type: DomainEvent["type"], a: StoredAction): DomainEvent {
	const e: DomainEvent = {
		type,
		orgId: a.orgId,
		idempotencyKey: a.idempotencyKey,
		tool: a.tool,
		scope: a.scope ?? null,
		cost: a.cost,
		status: a.status,
		at: a.updatedAt ?? a.createdAt,
	}
	if (a.reason != null) e.reason = a.reason
	return e
}

export function actionCreated(a: StoredAction): DomainEvent {
	return base("action.created", a)
}

export function actionTransition(a: StoredAction): DomainEvent {
	return base("action.transition", a)
}
