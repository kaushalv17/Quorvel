/**
 * Seed your Neon database with a lively, realistic snapshot so Quorvel Mission
 * Control looks alive the first time you open it against real data.
 *
 *   pnpm dashboard:seed
 *
 * Idempotent-ish: it clears the demo rows it owns (idempotency keys prefixed
 * with "seed:") before re-inserting, so you can run it repeatedly.
 */
import pg from "pg"

const url = process.env.DATABASE_URL
if (!url) {
  console.error("\u274c DATABASE_URL is not set. Run with: pnpm dashboard:seed (uses .env)")
  process.exit(1)
}
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } })

const TOOLS = ["charge.customer", "refund.issue", "email.send", "slack.notify", "db.write", "inventory.reserve", "shipment.create", "llm.complete", "webhook.deliver", "report.publish"]
const SCOPES = ["order-7741", "order-7742", "tenant-acme", "tenant-globex", "user-42", "batch-nightly"]
const pick = (a) => a[Math.floor(Math.random() * a.length)]
const rid = () => Math.random().toString(36).slice(2, 10)
const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString()

async function main() {
  const c = await pool.connect()
  try {
    console.log("\u25c8 Seeding Quorvel demo data\u2026")
    // wipe previously-seeded rows
    await c.query(`delete from belay_actions where idempotency_key like 'seed:%'`)
    await c.query(`delete from belay_workflows where workflow_id like 'seed-%'`)
    await c.query(`delete from belay_sagas where saga_id like 'seed-%'`)

    // --- actions across the last hour ---
    let n = 0
    for (let i = 0; i < 90; i++) {
      const r = Math.random()
      const status = r < 0.76 ? "succeeded" : r < 0.84 ? "running" : r < 0.92 ? "failed" : "succeeded"
      const t = 60 - (i / 90) * 60
      await c.query(
        `insert into belay_actions (idempotency_key, scope, tool, args, status, cost, attempts, error, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) on conflict (idempotency_key) do nothing`,
        [`seed:${rid()}`, pick(SCOPES), pick(TOOLS), JSON.stringify({ amount: Math.round(Math.random() * 200) }), status, Math.round(Math.random() * 600) / 100, status === "failed" ? 1 + (Math.random() * 2 | 0) : 0, status === "failed" ? pick(["upstream 503", "timeout", "rate limited"]) : null, minsAgo(t)],
      )
      n++
    }
    // --- pending approvals ---
    const approvals = [
      ["charge.customer", "tenant-globex", 42.5, "High-value charge exceeds the $40 auto-approve budget"],
      ["refund.issue", "order-7742", 18.0, "Refunds always require a human sign-off"],
      ["email.send", "batch-nightly", 0, "Bulk send to 1,240 recipients > 1k threshold"],
    ]
    for (const [tool, scope, cost, reason] of approvals) {
      await c.query(
        `insert into belay_actions (idempotency_key, scope, tool, args, status, cost, reason, created_at, updated_at)
         values ($1,$2,$3,$4,'awaiting_approval',$5,$6,now(),now()) on conflict (idempotency_key) do nothing`,
        [`seed:appr:${rid()}`, scope, tool, JSON.stringify({}), cost, reason],
      )
    }
    // --- workflows + event timelines ---
    const wfPlan = [
      ["deep-research", "completed", 5],
      ["onboarding", "completed", 5],
      ["invoice-run", "suspended", 3],
      ["nightly-sync", "running", 2],
      ["deep-research", "failed", 2],
    ]
    const seq = [["step", "plan"], ["step", "gather"], ["sleep", "cooldown"], ["signal", "publish-approval"], ["step", "publish"]]
    for (const [name, status, done] of wfPlan) {
      const id = `seed-wf-${rid()}`
      await c.query(
        `insert into belay_workflows (workflow_id, name, status, input, result, error, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,now()) on conflict (workflow_id) do nothing`,
        [id, name, status, JSON.stringify({ topic: "durable agents" }), status === "completed" ? JSON.stringify({ url: "https://reports.example/" + id }) : null, status === "failed" ? "step gather failed: upstream 503" : null, minsAgo(Math.random() * 50 + 5)],
      )
      for (let s = 0; s < seq.length; s++) {
        await c.query(
          `insert into belay_workflow_events (workflow_id, seq, type, name, status, result, fire_at)
           values ($1,$2,$3,$4,$5,$6,$7) on conflict (workflow_id, seq) do nothing`,
          [id, s, seq[s][0], seq[s][1], s < done ? "completed" : "pending", s < done ? JSON.stringify({ ok: true }) : null, seq[s][0] === "sleep" ? Date.now() + 3600000 : null],
        )
      }
    }
    // --- sagas ---
    const sagaPlan = [["succeeded", null], ["succeeded", null], ["compensated", "charge-card"], ["compensation_failed", "charge-card"]]
    const stepNames = ["reserve-inventory", "charge-card", "create-shipment"]
    for (const [status, failed] of sagaPlan) {
      const id = `seed-saga-${rid()}`
      await c.query(
        `insert into belay_sagas (saga_id, name, status, input, current_step, failed_step, error, created_at, updated_at)
         values ($1,'checkout',$2,$3,$4,$5,$6,now(),now()) on conflict (saga_id) do nothing`,
        [id, status, JSON.stringify({ cart: 3 }), stepNames.length, failed, status === "compensation_failed" ? "refund failed permanently" : null],
      )
      for (let s = 0; s < stepNames.length; s++) {
        await c.query(
          `insert into belay_saga_steps (saga_id, step_index, name, status)
           values ($1,$2,$3,$4) on conflict (saga_id, step_index) do nothing`,
          [id, s, stepNames[s], status === "compensated" && s >= 1 ? "compensated" : "succeeded"],
        )
      }
    }
    console.log(`\u2705 Seeded ${n} actions, ${approvals.length} approvals, ${wfPlan.length} workflows, ${sagaPlan.length} sagas.`)
    console.log("\u2192 Start the dashboard with: pnpm dashboard")
  } finally {
    c.release()
    await pool.end()
  }
}
main().catch((e) => { console.error("\u274c Seed failed:", e); process.exit(1) })
