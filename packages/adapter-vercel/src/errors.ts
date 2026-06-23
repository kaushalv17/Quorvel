// Typed error hierarchy. Every Quorvel-thrown error carries a stable `code`
// so callers (and the dashboard feed) can branch on it without string matching.

export class QuorvelError extends Error {
	readonly code: string
	constructor(code: string, message: string) {
		super(message)
		this.name = "QuorvelError"
		this.code = code
	}
}

// Thrown in `interrupt` approval mode: the agent loop should surface this to a
// human, then re-invoke the same tool call once the approval is resolved.
export class ApprovalRequiredError extends QuorvelError {
	readonly approvalId: string
	readonly toolName: string
	constructor(approvalId: string, toolName: string) {
		super(
			"approval_required",
			`Tool "${toolName}" requires human approval (approval ${approvalId}).`,
		)
		this.name = "ApprovalRequiredError"
		this.approvalId = approvalId
		this.toolName = toolName
	}
}

export class RejectedError extends QuorvelError {
	readonly approvalId?: string
	constructor(toolName: string, approvalId?: string) {
		super("rejected", `Tool "${toolName}" call was rejected by a reviewer.`)
		this.name = "RejectedError"
		this.approvalId = approvalId
	}
}

export class BudgetExceededError extends QuorvelError {
	readonly kind: "calls" | "cost"
	readonly limit: number
	constructor(kind: "calls" | "cost", limit: number) {
		super("budget_exceeded", `Quorvel budget exceeded (${kind} limit ${limit}).`)
		this.name = "BudgetExceededError"
		this.kind = kind
		this.limit = limit
	}
}

// Mark an error as permanently non-retryable from inside a tool's execute().
export class NonRetryableError extends QuorvelError {
	constructor(message: string) {
		super("non_retryable", message)
		this.name = "NonRetryableError"
	}
}

export class TimeoutError extends QuorvelError {
	readonly timeoutMs: number
	constructor(toolName: string, ms: number) {
		super("timeout", `Tool "${toolName}" timed out after ${ms}ms.`)
		this.name = "TimeoutError"
		this.timeoutMs = ms
	}
}

export function toErrorInfo(err: unknown): { message: string; code?: string } {
	if (err instanceof QuorvelError) return { message: err.message, code: err.code }
	if (err instanceof Error)
		return { message: err.message, code: (err as any).code }
	return { message: String(err) }
}
