import type { ActionStatus } from "../lib/quorvel"

const LABELS: Record<ActionStatus, string> = {
	pending: "pending",
	running: "running",
	succeeded: "succeeded",
	failed: "failed",
	awaiting_approval: "awaiting",
	approved: "approved",
	rejected: "rejected",
	denied: "denied",
}

export function StatusBadge({ status }: { status: ActionStatus }) {
	return <span className={`badge ${status}`}>{LABELS[status] ?? status}</span>
}
