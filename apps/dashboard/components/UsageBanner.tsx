import type { UsageSnapshot } from "../lib/quorvel"

// Warns an org when it is near or over its plan quota. Renders nothing when
// there's plenty of headroom or the plan is unlimited (near/over stay false).
export function UsageBanner({ usage }: { usage: UsageSnapshot }) {
  if (!usage.nearLimit && !usage.over) return null
  const pct = Math.round(usage.percentUsed * 100)
  const tone = usage.over ? "usage-banner-over" : "usage-banner-near"
  // Free plans hard-cap (new actions blocked); paid plans burst past the limit
  // and accrue overage that is reported, not auto-charged.
  const blocked = usage.over && usage.plan === "free"
  return (
    <div className={`usage-banner ${tone}`} role="status">
      {blocked ? (
        <span>
          <b>You&apos;ve hit your {usage.plan} quota.</b> New actions are blocked
          until usage resets ({usage.period}) or you upgrade your plan.
        </span>
      ) : usage.over ? (
        <span>
          <b>
            You&apos;re {usage.overage.toLocaleString()} action
            {usage.overage === 1 ? "" : "s"} over your {usage.plan} quota.
          </b>{" "}
          Usage keeps flowing this period ({usage.period}); overage isn&apos;t
          billed automatically.
        </span>
      ) : (
        <span>
          <b>
            You&apos;re at {pct}% of your {usage.plan} quota.
          </b>{" "}
          {usage.remaining.toLocaleString()} actions left this period ({usage.period}).
        </span>
      )}
    </div>
  )
}