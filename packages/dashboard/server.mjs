/**
 * Quorvel Mission Control — observability server.
 *
 * Zero web-framework: just Node's http + pg. Serves a single-page cinematic
 * dashboard from ./public and a small JSON API + a live Server-Sent-Events
 * stream over your real Quorvel tables in Postgres (Neon).
 *
 * Two data sources, chosen automatically:
 *   - PostgresSource : when DATABASE_URL is set (reads belay_* tables).
 *   - DemoSource     : when DATABASE_URL is missing or QUORVEL_DEMO=1. A living,
 *                      synthetic world so you can see the UI instantly.
 *
 * Run:
 *   pnpm dashboard            # real data if .env has DATABASE_URL, else demo
 *   pnpm dashboard:demo       # force the synthetic demo world
 */
import { createServer } from "node:http"
import { readFile, stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join, normalize, extname } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(__dirname, "public")

// Best-effort: load a local .env (cwd or repo root) with zero dependencies.
// Node 20.6+ ships process.loadEnvFile.
for (const envPath of [".env", join(__dirname, "..", "..", ".env")]) {
  try { if (typeof process.loadEnvFile === "function") { process.loadEnvFile(envPath); break } } catch { /* no .env here */ }
}

const PORT = Number(process.env.PORT || 4317) // 4317 = OTLP's port, a wink to observability
const FORCE_DEMO = process.argv.includes("--demo") || process.env.QUORVEL_DEMO === "1" || !process.env.DATABASE_URL

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
}

// ---------------------------------------------------------------------------
// Data source interface: overview(), runs(), workflows(), workflow(id),
// sagas(), approvals(), decide(id, approved), pulse()
// ---------------------------------------------------------------------------

class PostgresSource {
  constructor(pool) {
    this.pool = pool
    this.kind = "postgres"
  }
  async q(text, params) {
    const { rows } = await this.pool.query(text, params)
    return rows
  }
  async overview() {
    const [actions, sagas, workflows, cost, recent] = await Promise.all([
      this.q(`select status, count(*)::int n from belay_actions group by status`),
      this.q(`select status, count(*)::int n from belay_sagas group by status`),
      this.q(`select status, count(*)::int n from belay_workflows group by status`),
      this.q(`select coalesce(sum(cost),0)::float total from belay_actions where status in ('succeeded','running')`),
      this.q(`select date_trunc('minute', created_at) m, count(*)::int n
               from belay_actions where created_at > now() - interval '60 minutes'
               group by 1 order by 1`),
    ])
    return buildOverview({ actions, sagas, workflows, cost: cost[0]?.total || 0, recent })
  }
  async runs(limit = 40) {
    return this.q(
      `select idempotency_key id, tool, scope, status, cost, attempts, error,
              extract(epoch from created_at)*1000 created_at,
              extract(epoch from updated_at)*1000 updated_at
         from belay_actions order by created_at desc limit $1`,
      [limit],
    )
  }
  async workflows(limit = 40) {
    return this.q(
      `select workflow_id id, name, status,
              extract(epoch from created_at)*1000 created_at,
              extract(epoch from updated_at)*1000 updated_at
         from belay_workflows order by created_at desc limit $1`,
      [limit],
    )
  }
  async workflow(id) {
    const [run] = await this.q(
      `select workflow_id id, name, status, input, result, error,
              extract(epoch from created_at)*1000 created_at,
              extract(epoch from updated_at)*1000 updated_at
         from belay_workflows where workflow_id = $1`,
      [id],
    )
    if (!run) return null
    const events = await this.q(
      `select seq, type, name, status, result, fire_at,
              extract(epoch from created_at)*1000 created_at,
              extract(epoch from updated_at)*1000 updated_at
         from belay_workflow_events where workflow_id = $1 order by seq asc`,
      [id],
    )
    return { ...run, events }
  }
  async sagas(limit = 40) {
    const sagas = await this.q(
      `select saga_id id, name, status, current_step, failed_step, error,
              extract(epoch from created_at)*1000 created_at
         from belay_sagas order by created_at desc limit $1`,
      [limit],
    )
    for (const s of sagas) {
      s.steps = await this.q(
        `select step_index, name, status, error from belay_saga_steps
          where saga_id = $1 order by step_index asc`,
        [s.id],
      )
    }
    return sagas
  }
  async approvals() {
    return this.q(
      `select idempotency_key id, tool, scope, cost, reason,
              extract(epoch from created_at)*1000 created_at
         from belay_actions where status = 'awaiting_approval' order by created_at asc`,
    )
  }
  async decide(id, approved) {
    await this.q(`update belay_actions set status = $2, updated_at = now() where idempotency_key = $1`, [
      id,
      approved ? "approved" : "rejected",
    ])
    return { id, status: approved ? "approved" : "rejected" }
  }
  async pulse() {
    return this.overview()
  }
}

// ---------------------------------------------------------------------------
// Demo world: a living simulation so the UI is gorgeous with no DB attached.
// ---------------------------------------------------------------------------
const TOOLS = [
  "charge.customer", "refund.issue", "email.send", "slack.notify",
  "db.write", "inventory.reserve", "shipment.create", "llm.complete",
  "webhook.deliver", "report.publish",
]
const SCOPES = ["order-7741", "order-7742", "tenant-acme", "tenant-globex", "user-42", "batch-nightly"]
const WF_NAMES = ["deep-research", "onboarding", "invoice-run", "nightly-sync"]
const rid = () => Math.random().toString(36).slice(2, 10)
const pick = (a) => a[Math.floor(Math.random() * a.length)]

class DemoSource {
  constructor() {
    this.kind = "demo"
    this.actions = []
    this._wf = []
    this._sg = []
    this.t0 = Date.now()
    for (let i = 0; i < 60; i++) this.spawnAction(Date.now() - (60 - i) * 45_000)
    for (let i = 0; i < 6; i++) this.spawnWorkflow(Date.now() - (6 - i) * 120_000)
    for (let i = 0; i < 4; i++) this.spawnSaga(Date.now() - (4 - i) * 90_000)
    // a few pending approvals
    for (let i = 0; i < 3; i++) {
      const a = this.spawnAction(Date.now() - i * 20_000)
      a.status = "awaiting_approval"
      a.cost = [4200, 980, 15000][i] || 500
      a.reason = ["High-value charge over $40 budget", "Refund needs human sign-off", "Bulk email > 1k recipients"][i]
    }
  }
  spawnAction(ts = Date.now()) {
    const r = Math.random()
    const status = r < 0.74 ? "succeeded" : r < 0.82 ? "running" : r < 0.9 ? "failed" : r < 0.96 ? "awaiting_approval" : "pending"
    const a = {
      id: rid(),
      tool: pick(TOOLS),
      scope: pick(SCOPES),
      status,
      cost: Math.round(Math.random() * 800) / 100,
      attempts: status === "failed" ? 1 + Math.floor(Math.random() * 3) : Math.random() < 0.2 ? 1 : 0,
      error: status === "failed" ? pick(["upstream 503", "timeout after 30s", "rate limited", "connection reset"]) : null,
      reason: null,
      created_at: ts,
      updated_at: ts + Math.round(Math.random() * 4000),
    }
    this.actions.push(a)
    if (this.actions.length > 400) this.actions.shift()
    return a
  }
  spawnWorkflow(ts = Date.now()) {
    const status = pick(["completed", "completed", "suspended", "running", "failed"])
    const id = "wf-" + rid()
    const seqTypes = [
      { type: "step", name: "plan" },
      { type: "step", name: "gather" },
      { type: "sleep", name: "cooldown" },
      { type: "signal", name: "publish-approval" },
      { type: "step", name: "publish" },
    ]
    const done = status === "completed" ? seqTypes.length : status === "failed" ? 2 : 1 + Math.floor(Math.random() * 3)
    const events = seqTypes.map((e, i) => ({
      seq: i,
      type: e.type,
      name: e.name,
      status: i < done ? "completed" : "pending",
      result: null,
      fire_at: e.type === "sleep" ? ts + 3600_000 : null,
      created_at: ts + i * 600,
      updated_at: ts + i * 600 + 400,
    }))
    const wf = { id, name: pick(WF_NAMES), status, input: { topic: "durable agents" }, result: status === "completed" ? { url: "https://reports.example/" + id } : null, error: status === "failed" ? "step gather failed: upstream 503" : null, created_at: ts, updated_at: ts + done * 600, events }
    this._wf.push(wf)
    if (this._wf.length > 60) this._wf.shift()
    return wf
  }
  spawnSaga(ts = Date.now()) {
    const status = pick(["succeeded", "succeeded", "compensated", "running", "compensation_failed"])
    const id = "saga-" + rid()
    const names = ["reserve-inventory", "charge-card", "create-shipment"]
    const steps = names.map((n, i) => ({ step_index: i, name: n, status: status === "compensated" && i >= 1 ? "compensated" : "succeeded", error: null }))
    return (this._sg.push({ id, name: "checkout", status, current_step: steps.length, failed_step: status.includes("compens") ? "charge-card" : null, error: status === "compensation_failed" ? "refund failed permanently" : null, created_at: ts, steps }), this._sg[this._sg.length - 1])
  }
  tick() {
    // keep the world alive
    if (Math.random() < 0.8) this.spawnAction()
    // advance a running workflow
    const running = this._wf.find((w) => w.status === "running" || w.status === "suspended")
    if (running && Math.random() < 0.5) {
      const next = running.events.find((e) => e.status === "pending")
      if (next) {
        next.status = "completed"
        next.updated_at = Date.now()
        running.updated_at = Date.now()
        if (!running.events.some((e) => e.status === "pending")) {
          running.status = "completed"
          running.result = { url: "https://reports.example/" + running.id }
        }
      }
    }
    if (Math.random() < 0.15) this.spawnWorkflow()
  }
  async overview() {
    const group = (arr, key) => arr.reduce((m, x) => ((m[x[key]] = (m[x[key]] || 0) + 1), m), {})
    const recentMap = {}
    const now = Date.now()
    for (const a of this.actions) {
      if (a.created_at > now - 3600_000) {
        const m = Math.floor(a.created_at / 60000) * 60000
        recentMap[m] = (recentMap[m] || 0) + 1
      }
    }
    const recent = Object.entries(recentMap).sort().map(([m, n]) => ({ m: Number(m), n }))
    return buildOverview({
      actions: Object.entries(group(this.actions, "status")).map(([status, n]) => ({ status, n })),
      sagas: Object.entries(group(this._sg, "status")).map(([status, n]) => ({ status, n })),
      workflows: Object.entries(group(this._wf, "status")).map(([status, n]) => ({ status, n })),
      cost: this.actions.filter((a) => ["succeeded", "running"].includes(a.status)).reduce((s, a) => s + a.cost, 0),
      recent,
    })
  }
  async runs(limit = 40) {
    return [...this.actions].sort((a, b) => b.created_at - a.created_at).slice(0, limit)
  }
  async workflows(limit = 40) {
    return [...this._wf].sort((a, b) => b.created_at - a.created_at).slice(0, limit).map(({ events, ...w }) => w)
  }
  async workflow(id) {
    return this._wf.find((w) => w.id === id) || null
  }
  async sagas(limit = 40) {
    return [...this._sg].sort((a, b) => b.created_at - a.created_at).slice(0, limit)
  }
  async approvals() {
    return this.actions.filter((a) => a.status === "awaiting_approval")
  }
  async decide(id, approved) {
    const a = this.actions.find((x) => x.id === id)
    if (a) {
      a.status = approved ? "approved" : "rejected"
      a.updated_at = Date.now()
    }
    return { id, status: approved ? "approved" : "rejected" }
  }
  async pulse() {
    this.tick()
    return this.overview()
  }
}


// ---------------------------------------------------------------------------
// Shared overview shape
// ---------------------------------------------------------------------------
function buildOverview({ actions, sagas, workflows, cost, recent }) {
  const sum = (rows) => rows.reduce((s, r) => s + r.n, 0)
  const byStatus = (rows) => rows.reduce((m, r) => ((m[r.status] = r.n), m), {})
  const A = byStatus(actions)
  const W = byStatus(workflows)
  const S = byStatus(sagas)
  const totalActions = sum(actions)
  const succeeded = A.succeeded || 0
  const failed = A.failed || 0
  const finished = succeeded + failed
  const successRate = finished ? succeeded / finished : 1
  return {
    generatedAt: Date.now(),
    kpis: {
      actions: totalActions,
      running: (A.running || 0) + (W.running || 0),
      awaitingApproval: A.awaiting_approval || 0,
      failed,
      successRate,
      cost,
      activeWorkflows: (W.running || 0) + (W.suspended || 0),
      compensating: (S.compensating || 0) + (S.compensation_failed || 0),
    },
    actionsByStatus: A,
    workflowsByStatus: W,
    sagasByStatus: S,
    throughput: recent.map((r) => ({ t: r.m, n: r.n })),
  }
}

// ---------------------------------------------------------------------------
// HTTP wiring
// ---------------------------------------------------------------------------
async function makeSource() {
  if (FORCE_DEMO) {
    console.log("\u25c8 Quorvel Mission Control — DEMO mode (synthetic data)")
    return new DemoSource()
  }
  const pg = (await import("pg")).default
  const url = process.env.DATABASE_URL
  const needsSsl = /sslmode=require|sslmode=verify-full|neon\.tech|\.aws\./i.test(url)
  const pool = new pg.Pool({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : undefined })
  await pool.query("select 1")
  console.log("\u25c8 Quorvel Mission Control — LIVE mode (Postgres)")
  return new PostgresSource(pool)
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, { "content-type": MIME[".json"], "cache-control": "no-store" })
  res.end(body)
}

async function serveStatic(res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname
  const filePath = normalize(join(PUBLIC_DIR, rel))
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "forbidden" })
  try {
    const s = await stat(filePath)
    if (!s.isFile()) throw new Error("not a file")
    const buf = await readFile(filePath)
    res.writeHead(200, { "content-type": MIME[extname(filePath)] || "application/octet-stream" })
    res.end(buf)
  } catch {
    sendJson(res, 404, { error: "not found", pathname })
  }
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) } catch { return {} }
}

const sseClients = new Set()

async function main() {
  const source = await makeSource()

  const server = createServer(async (req, res) => {
    const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host}`)
    try {
      if (pathname === "/api/meta") return sendJson(res, 200, { mode: source.kind, port: PORT, version: "0.5.0" })
      if (pathname === "/api/overview") return sendJson(res, 200, await source.overview())
      if (pathname === "/api/runs") return sendJson(res, 200, await source.runs(Number(searchParams.get("limit")) || 40))
      if (pathname === "/api/workflows") return sendJson(res, 200, await source.workflows(Number(searchParams.get("limit")) || 40))
      if (pathname.startsWith("/api/workflows/")) {
        const id = decodeURIComponent(pathname.split("/").pop())
        const wf = await source.workflow(id)
        return wf ? sendJson(res, 200, wf) : sendJson(res, 404, { error: "not found" })
      }
      if (pathname === "/api/sagas") return sendJson(res, 200, await source.sagas(Number(searchParams.get("limit")) || 40))
      if (pathname === "/api/approvals") return sendJson(res, 200, await source.approvals())
      if (pathname.startsWith("/api/approvals/") && req.method === "POST") {
        const parts = pathname.split("/")
        const id = decodeURIComponent(parts[3])
        const action = parts[4]
        const result = await source.decide(id, action === "approve")
        broadcast("approval", result)
        return sendJson(res, 200, result)
      }
      if (pathname === "/api/stream") return startStream(req, res, source)
      if (pathname.startsWith("/api/")) return sendJson(res, 404, { error: "unknown endpoint" })
      return serveStatic(res, pathname)
    } catch (err) {
      console.error(err)
      sendJson(res, 500, { error: String(err && err.message || err) })
    }
  })

  // Heartbeat: every 2s recompute the pulse and push to SSE clients.
  setInterval(async () => {
    if (!sseClients.size && source.kind === "postgres") return
    try {
      const overview = await source.pulse()
      broadcast("pulse", overview)
    } catch (e) { /* ignore transient */ }
  }, 2000)

  server.listen(PORT, () => {
    console.log(`\u2192 http://localhost:${PORT}`)
  })
}

function startStream(req, res, source) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  res.write(`event: hello\ndata: ${JSON.stringify({ mode: source.kind })}\n\n`)
  sseClients.add(res)
  req.on("close", () => sseClients.delete(res))
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of sseClients) {
    try { res.write(payload) } catch { sseClients.delete(res) }
  }
}

main().catch((err) => {
  console.error("\u274c Mission Control failed to start:", err)
  process.exit(1)
})
