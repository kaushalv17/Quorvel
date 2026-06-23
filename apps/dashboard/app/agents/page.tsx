import Link from "next/link"
import { serverClient } from "../../lib/server-client"
import { groupByScope } from "../../lib/quorvel"

export const dynamic = "force-dynamic"

export default async function AgentsPage() {
	const recent = await serverClient().listRecent(200)
	const grouped = groupByScope(recent)
	const scopes = [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)

	return (
		<>
			<h1>Agents</h1>
			<p className="subtle">Recent activity grouped by agent scope. Click through for a full timeline.</p>

			{scopes.length === 0 ? (
				<div className="empty">No activity yet.</div>
			) : (
				<div className="agent-grid">
					{scopes.map(([scope, actions]) => {
						const waiting = actions.filter((a) => a.status === "awaiting_approval").length
						return (
							<Link
								className="card agent-card"
								key={scope}
								href={`/agents/${encodeURIComponent(scope)}`}
							>
								<div className="count">{actions.length}</div>
								<div className="card-title">{scope}</div>
								<div className="card-meta">
									{waiting > 0 ? `${waiting} awaiting approval` : "all clear"}
								</div>
							</Link>
						)
					})}
				</div>
			)}
		</>
	)
}
