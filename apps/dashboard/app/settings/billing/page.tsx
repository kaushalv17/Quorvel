import { serverClient } from "@/lib/server-client"
import { UpgradeButton } from "@/components/UpgradeButton"
import { ManageBillingButton } from "@/components/ManageBillingButton"

// Self-serve billing (Phase 2): shows the org's current plan + usage, lets the
// user upgrade via Paddle checkout, and opens the hosted portal to manage an
// existing subscription.
export const dynamic = "force-dynamic"

export default async function BillingPage() {
	const me = await serverClient().me()
	const { plan } = me.org
	const { used, limit, overage } = me.usage
  const { features } = me
  const fmt = (n: number | null) =>
    n === null || !Number.isFinite(n) ? "Unlimited" : String(n)
	const finiteLimit = Number.isFinite(limit)
	const pct =
		finiteLimit && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0

	return (
		<>
			<h1>Billing</h1>
			<p className="subtle">
				Manage your plan, payment method, and invoices. Payments are processed by
				Paddle (Merchant of Record).
			</p>

			<div className="billing-summary card">
				<div className="stat">
					<b>{plan}</b>
					<span>current plan</span>
				</div>
				<div className="stat">
					<b>
						{used}
						{finiteLimit ? ` / ${limit}` : " / \u221e"}
					</b>
					<span>actions this period</span>
            {overage > 0 ? (
              <span className="overage-note">
                {overage.toLocaleString()} over your plan limit
              </span>
            ) : null}
				</div>
				{finiteLimit ? (
					<div className="usage-meter">
						<div className="usage-meter-fill" style={{ width: `${pct}%` }} />
					</div>
				) : null}
			</div>

			<div className="plan-limits card">
        <h3>Plan limits</h3>
        <ul className="limit-list">
          <li>
            <span>Alert rules</span>
            <b>{features.alertRulesUsed} / {fmt(features.maxAlertRules)}</b>
          </li>
          <li>
            <span>History retention</span>
            <b>{Number.isFinite(features.retentionDays) ? `${features.retentionDays} days` : "Unlimited"}</b>
          </li>
          <li>
            <span>Team seats</span>
            <b>{fmt(features.maxSeats)}</b>
          </li>
        </ul>
      </div>

      <div className="billing-actions">
				<ManageBillingButton />
			</div>

			<div className="plans">
				<div className="plan-card card">
					<h3>Pro</h3>
					<p className="subtle">100,000 tracked actions / month.</p>
					<UpgradeButton plan="pro" label="Upgrade to Pro" />
				</div>
				<div className="plan-card card">
					<h3>Scale</h3>
					<p className="subtle">Unlimited actions + priority support.</p>
					<UpgradeButton plan="scale" label="Upgrade to Scale" />
				</div>
			</div>
		</>
	)
}
