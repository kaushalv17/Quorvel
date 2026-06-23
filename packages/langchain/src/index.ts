/**
 * @quorvel/langchain — Quorvel reliability adapter for LangChain JS & LangGraph.
 *
 * Two drop-in surfaces:
 *  - `withQuorvel` / `withQuorvelAll`: wrap LangChain tools so they keep their
 *    name/description/schema but route execution through Quorvel. Hand them to
 *    `bindTools`, a prebuilt `ToolNode`, or `createReactAgent` unchanged.
 *  - `createToolRunner` / `guard`: guard the manual tool-calling loop, turning
 *    an AIMessage's `tool_calls` into ready-to-append `ToolMessage`s.
 *
 * Every surface gives you exactly-once idempotency, a durable action ledger,
 * and policy enforcement (budgets, rate limits, approval gates, hard denies).
 */
export { withQuorvel, withQuorvelAll, type LangChainToolLike } from "./tools"
export {
	createToolRunner,
	guard,
	type ToolCall,
	type ToolHandler,
	type ToolRunnerOptions,
} from "./graph"
export {
	type QuorvelBinding,
	type QuorvelInvocationContext,
	type Resolvable,
	type ApprovalPendingInfo,
	type PolicyDeniedInfo,
	defaultPendingResult,
	defaultDeniedResult,
} from "./types"

// Re-export the approvals inbox API so callers can resolve parked actions
// without a direct `belay` import.
export { approve, reject, listPendingApprovals } from "@quorvel/core"
