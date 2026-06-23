// Quorvel Mission Control — client. Vanilla ES modules, no build step.
const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const api = (p, o) => fetch(p, o).then((r) => r.json())
const fmt = new Intl.NumberFormat("en", { maximumFractionDigits: 1 })
const money = (n) => "$" + new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(n || 0)
const ago = (ts) => {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return Math.floor(s) + "s"
  if (s < 3600) return Math.floor(s / 60) + "m"
  if (s < 86400) return Math.floor(s / 3600) + "h"
  return Math.floor(s / 86400) + "d"
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
const STATUS_COLORS = { succeeded: "#34e3a5", completed: "#34e3a5", approved: "#34e3a5", running: "#5aa6ff", pending: "#8b97bd", failed: "#ff5d6c", rejected: "#ff5d6c", compensation_failed: "#ff5d6c", awaiting_approval: "#c08bff", suspended: "#c08bff", compensated: "#ffb347", compensating: "#ffb347" }

const state = { view: "overview", overview: null, lastPulse: 0, seenRuns: new Set(), feedInit: false }

// ============================ AURORA BACKGROUND ============================
;(function aurora() {
  const c = $("#aurora"), x = c.getContext("2d")
  let w, h, blobs
  const palette = [[124, 92, 255], [34, 211, 238], [52, 227, 165], [192, 139, 255]]
  function resize() { w = c.width = innerWidth; h = c.height = innerHeight }
  function init() {
    blobs = palette.map((col, i) => ({ col, x: Math.random() * w, y: Math.random() * h, r: 260 + Math.random() * 220, a: Math.random() * 6.28, s: 0.0006 + Math.random() * 0.0009, vr: 0.4 + Math.random() * 0.5 }))
  }
  function frame(t) {
    x.clearRect(0, 0, w, h)
    x.globalCompositeOperation = "lighter"
    for (const b of blobs) {
      b.a += b.s
      const cx = b.x + Math.cos(b.a) * 120 * b.vr, cy = b.y + Math.sin(b.a * 1.3) * 120 * b.vr
      const g = x.createRadialGradient(cx, cy, 0, cx, cy, b.r)
      g.addColorStop(0, `rgba(${b.col.join(",")},.42)`)
      g.addColorStop(1, `rgba(${b.col.join(",")},0)`)
      x.fillStyle = g; x.beginPath(); x.arc(cx, cy, b.r, 0, 6.2832); x.fill()
    }
    requestAnimationFrame(frame)
  }
  addEventListener("resize", () => { resize(); init() })
  resize(); init(); requestAnimationFrame(frame)
})()

// ============================ CLOCK ============================
setInterval(() => { $("#clock").textContent = new Date().toLocaleTimeString("en-GB") }, 1000)

// ============================ ROUTING ============================
const VIEWS = {
  overview: { title: "Overview", sub: "Live reliability telemetry for your agent fleet" },
  runs: { title: "Action Ledger", sub: "Every guarded action, exactly once · idempotent" },
  workflows: { title: "Workflows", sub: "Durable executions · checkpointed & resumable" },
  sagas: { title: "Sagas", sub: "Distributed transactions with automatic compensation" },
  approvals: { title: "Approvals", sub: "Human-in-the-loop gates awaiting your decision" },
}
function go(view, arg) {
  state.view = view
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view))
  $("#viewTitle").textContent = VIEWS[view].title
  $("#viewSub").textContent = VIEWS[view].sub
  const stage = $("#stage")
  if (view === "overview") renderOverview(stage)
  else if (view === "runs") renderRuns(stage)
  else if (view === "workflows") arg ? renderWorkflowDetail(stage, arg) : renderWorkflows(stage)
  else if (view === "sagas") renderSagas(stage)
  else if (view === "approvals") renderApprovals(stage)
}
$("#nav").addEventListener("click", (e) => { const b = e.target.closest(".nav-item"); if (b) go(b.dataset.view) })

// ============================ OVERVIEW ============================
async function renderOverview(stage) {
  stage.innerHTML = ""
  stage.appendChild($("#tpl-overview").content.cloneNode(true))
  const ov = state.overview || (await api("/api/overview"))
  state.overview = ov
  paintKpis(ov)
  paintThroughput(ov.throughput)
  paintDonut(ov.actionsByStatus)
  const runs = await api("/api/runs?limit=22")
  state.feedInit = false
  paintFeed(runs)
}

const KPI_DEFS = [
  { key: "successRate", label: "Success rate", cls: "k-ok", pct: true, foot: (o) => `${o.failed} failed · ${o.actions} total` },
  { key: "actions", label: "Actions", cls: "k-brand", foot: () => "guarded · idempotent" },
  { key: "activeWorkflows", label: "Active workflows", cls: "k-info", foot: () => "running + suspended" },
  { key: "running", label: "In flight", cls: "k-info", foot: () => "executing now" },
  { key: "awaitingApproval", label: "Awaiting approval", cls: "k-hold", foot: () => "needs a human" },
  { key: "cost", label: "Spend tracked", cls: "k-warn", money: true, foot: () => "budget-metered" },
]
function paintKpis(ov) {
  const host = $("#kpis"); if (!host) return
  host.innerHTML = KPI_DEFS.map((d) => {
    const raw = ov.kpis[d.key] ?? 0
    const val = d.pct ? Math.round(raw * 100) + "%" : d.money ? money(raw) : fmt.format(raw)
    return `<div class="kpi ${d.cls}"><div class="glowtab"></div>
      <div class="k-label">${d.label}</div>
      <div class="k-val" data-kpi="${d.key}" data-raw="${raw}">${val}</div>
      <div class="k-foot">${esc(d.foot(ov.kpis))}</div>
      <svg class="spark" viewBox="0 0 120 46" preserveAspectRatio="none"><path data-spark="${d.key}" fill="none" stroke="${STATUS_COLORS.running}" stroke-width="2" opacity=".5"/></svg>
    </div>`
  }).join("")
  // sparklines from throughput as a shared shimmer
  const tp = (ov.throughput || []).map((p) => p.n)
  $$("[data-spark]").forEach((p) => p.setAttribute("d", sparkPath(tp.length ? tp : [1, 2, 1, 3, 2, 4], 120, 46)))
}
function bumpKpis(ov) {
  KPI_DEFS.forEach((d) => {
    const el = $(`[data-kpi="${d.key}"]`); if (!el) return
    const raw = ov.kpis[d.key] ?? 0
    if (String(raw) === el.dataset.raw) return
    el.dataset.raw = raw
    el.textContent = d.pct ? Math.round(raw * 100) + "%" : d.money ? money(raw) : fmt.format(raw)
    el.classList.remove("count-flip"); void el.offsetWidth; el.classList.add("count-flip")
  })
}

function sparkPath(vals, w, h) {
  if (!vals.length) return ""
  const max = Math.max(...vals, 1), min = Math.min(...vals, 0)
  const span = max - min || 1
  return vals.map((v, i) => {
    const x = (i / (vals.length - 1 || 1)) * w
    const y = h - 4 - ((v - min) / span) * (h - 8)
    return (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1)
  }).join(" ")
}

function paintThroughput(tp) {
  const host = $("#throughputChart"); if (!host) return
  const data = (tp || []).slice(-40)
  if (data.length < 2) { host.innerHTML = `<div class="empty">No traffic in the last hour yet.</div>`; return }
  const W = 800, H = 180, pad = 8
  const vals = data.map((d) => d.n), max = Math.max(...vals, 1)
  const xs = (i) => pad + (i / (data.length - 1)) * (W - pad * 2)
  const ys = (v) => H - 18 - (v / max) * (H - 36)
  const line = data.map((d, i) => (i ? "L" : "M") + xs(i).toFixed(1) + " " + ys(d.n).toFixed(1)).join(" ")
  const area = `M${xs(0)} ${H - 18} ` + data.map((d, i) => "L" + xs(i).toFixed(1) + " " + ys(d.n).toFixed(1)).join(" ") + ` L${xs(data.length - 1)} ${H - 18} Z`
  const last = data[data.length - 1]
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}">
    <defs><linearGradient id="areaGrad" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="#22d3ee" stop-opacity=".35"/><stop offset="1" stop-color="#22d3ee" stop-opacity="0"/>
    </linearGradient></defs>
    <line class="axis" x1="${pad}" y1="${H - 18}" x2="${W - pad}" y2="${H - 18}"/>
    <path class="area" d="${area}"/><path class="line" d="${line}"/>
    <circle class="dot" cx="${xs(data.length - 1)}" cy="${ys(last.n)}" r="4"/>
    <text class="glab" x="${pad}" y="${H - 4}">-60m</text>
    <text class="glab" x="${W - pad}" y="${H - 4}" text-anchor="end">now</text>
    <text class="glab" x="${xs(data.length - 1) - 6}" y="${ys(last.n) - 10}" text-anchor="end" fill="#22d3ee">${last.n}/min</text>
  </svg>`
}

function paintDonut(byStatus) {
  const host = $("#statusDonut"); if (!host) return
  const entries = Object.entries(byStatus || {}).filter(([, n]) => n > 0)
  const total = entries.reduce((s, [, n]) => s + n, 0) || 1
  let a0 = -Math.PI / 2
  const R = 60, r = 38, cx = 70, cy = 70
  const arcs = entries.map(([st, n]) => {
    const a1 = a0 + (n / total) * Math.PI * 2
    const big = a1 - a0 > Math.PI ? 1 : 0
    const p = (ang, rad) => [cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad]
    const [x0, y0] = p(a0, R), [x1, y1] = p(a1, R), [x2, y2] = p(a1, r), [x3, y3] = p(a0, r)
    a0 = a1
    return `<path d="M${x0} ${y0} A${R} ${R} 0 ${big} 1 ${x1} ${y1} L${x2} ${y2} A${r} ${r} 0 ${big} 0 ${x3} ${y3} Z" fill="${STATUS_COLORS[st] || "#888"}" opacity=".9"/>`
  }).join("")
  const legend = entries.sort((a, b) => b[1] - a[1]).map(([st, n]) => `<div class="lg"><i style="background:${STATUS_COLORS[st] || "#888"}"></i>${st.replace(/_/g, " ")}<b>${n}</b></div>`).join("")
  host.innerHTML = `<svg viewBox="0 0 140 140">${arcs}<text x="70" y="66" text-anchor="middle" fill="#eaf0ff" font-size="26" font-weight="800">${total}</text><text x="70" y="84" text-anchor="middle" fill="#5c668c" font-size="10">actions</text></svg><div class="legend">${legend}</div>`
}

function feedRow(r) {
  return `<div class="feed-row" data-id="${esc(r.id)}"><span class="pill s-${r.status}">${r.status.replace(/_/g, " ")}</span>
    <span><span class="tool">${esc(r.tool)}</span> <span class="scope">${esc(r.scope || "")}</span></span>
    <span class="cost">${r.cost ? money(r.cost) : ""}</span><span class="ts">${ago(r.created_at)}</span></div>`
}
function paintFeed(runs) {
  const host = $("#feed"); if (!host) return
  host.innerHTML = runs.map(feedRow).join("")
  runs.forEach((r) => state.seenRuns.add(r.id))
  state.feedInit = true
}

// ============================ RUNS ============================
let runsFilter = "all", runsData = []
async function renderRuns(stage) {
  stage.innerHTML = `<div class="toolbar">
    <div class="seg" id="runSeg">${["all", "succeeded", "running", "failed", "awaiting_approval"].map((s) => `<button data-f="${s}" class="${s === runsFilter ? "active" : ""}">${s.replace(/_/g, " ")}</button>`).join("")}</div>
    <input class="search-in" id="runSearch" placeholder="Filter by tool or scope…"/></div>
    <div class="list" id="runList"><div class="skeleton" style="height:54px"></div></div>`
  runsData = await api("/api/runs?limit=80")
  paintRuns()
  $("#runSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; runsFilter = b.dataset.f; $$("#runSeg button").forEach((x) => x.classList.toggle("active", x === b)); paintRuns() })
  $("#runSearch").addEventListener("input", paintRuns)
}
function paintRuns() {
  const q = ($("#runSearch")?.value || "").toLowerCase()
  let rows = runsData.filter((r) => runsFilter === "all" || r.status === runsFilter)
  if (q) rows = rows.filter((r) => (r.tool + " " + (r.scope || "")).toLowerCase().includes(q))
  const host = $("#runList")
  if (!rows.length) { host.innerHTML = `<div class="empty"><div class="big">✨</div>No matching actions.</div>`; return }
  host.innerHTML = rows.map((r) => `<div class="row-card">
    <span class="pill s-${r.status}">${r.status.replace(/_/g, " ")}</span>
    <span><div class="r-title">${esc(r.tool)}</div><div class="r-meta">${esc(r.scope || "no scope")}${r.error ? " · <span style='color:#ff8a94'>" + esc(r.error) + "</span>" : ""}</div></span>
    <span class="attempts">${r.attempts ? "↺ " + r.attempts : ""}</span>
    <span class="r-cost">${r.cost ? money(r.cost) : ""}</span>
    <span class="ts" style="color:var(--faint);font-size:11px">${ago(r.created_at)} ago</span></div>`).join("")
}

// ============================ WORKFLOWS ============================
async function renderWorkflows(stage) {
  stage.innerHTML = `<div class="list" id="wfList"><div class="skeleton" style="height:54px"></div></div>`
  const wfs = await api("/api/workflows?limit=60")
  const host = $("#wfList")
  if (!wfs.length) { host.innerHTML = `<div class="empty"><div class="big">✨</div>No workflows yet. Run <code>pnpm demo:workflow</code>.</div>`; return }
  host.innerHTML = wfs.map((w) => `<div class="row-card" data-wf="${esc(w.id)}">
    <span class="pill s-${w.status}">${w.status}</span>
    <span><div class="r-title">${esc(w.name)}</div><div class="r-meta">${esc(w.id)}</div></span>
    <span></span><span class="r-cost">${ago(w.created_at)} ago</span><span style="color:var(--faint)">→</span></div>`).join("")
  host.addEventListener("click", (e) => { const c = e.target.closest("[data-wf]"); if (c) go("workflows", c.dataset.wf) })
}
async function renderWorkflowDetail(stage, id) {
  stage.innerHTML = `<button class="back-btn" id="wfBack">← All workflows</button><div class="skeleton" style="height:200px"></div>`
  $("#wfBack").addEventListener("click", () => go("workflows"))
  const wf = await api("/api/workflows/" + encodeURIComponent(id))
  if (!wf) { stage.innerHTML += `<div class="empty">Workflow not found.</div>`; return }
  const events = wf.events || []
  const icon = { step: "◆", sleep: "⏳", signal: "✉", now: "⏱", random: "₿" }
  const steps = events.map((e, i) => {
    const done = e.status === "completed"
    return `<div class="wf-step"><div class="wf-rail"><div class="wf-node ${done ? "done" : "pending"}">${icon[e.type] || "◆"}</div>${i < events.length - 1 ? `<div class="wf-line ${done ? "done" : ""}"></div>` : ""}</div>
      <div class="wf-body"><div class="wf-name">${esc(e.name)}</div><div class="wf-kind">${e.type} · seq ${e.seq} · <span class="pill s-${done ? "completed" : "pending"}" style="padding:1px 7px">${e.status}</span></div>
      ${e.result != null ? `<div class="kv"><code>${esc(JSON.stringify(e.result)).slice(0, 120)}</code></div>` : ""}</div></div>`
  }).join("")
  stage.innerHTML = `<button class="back-btn" id="wfBack2">← All workflows</button>
    <div class="detail"><div class="panel"><div class="panel-head"><h3>${esc(wf.name)} <span class="pill s-${wf.status}">${wf.status}</span></h3><span class="panel-sub">${esc(wf.id)}</span></div>
    <div class="kv">${wf.input != null ? `<code>input: ${esc(JSON.stringify(wf.input)).slice(0, 140)}</code>` : ""}${wf.result != null ? `<code>result: ${esc(JSON.stringify(wf.result)).slice(0, 140)}</code>` : ""}${wf.error ? `<code style="color:#ff8a94">${esc(wf.error)}</code>` : ""}</div></div>
    <div class="panel"><div class="panel-head"><h3>Execution timeline</h3><span class="panel-sub">${events.length} checkpointed events</span></div><div class="waterfall">${steps || '<div class="empty">No events recorded.</div>'}</div></div></div>`
  $("#wfBack2").addEventListener("click", () => go("workflows"))
}

// ============================ SAGAS ============================
async function renderSagas(stage) {
  stage.innerHTML = `<div class="list" id="sagaList"><div class="skeleton" style="height:80px"></div></div>`
  const sagas = await api("/api/sagas?limit=40")
  const host = $("#sagaList")
  if (!sagas.length) { host.innerHTML = `<div class="empty"><div class="big">⚛</div>No sagas yet. Run <code>pnpm demo:saga</code>.</div>`; return }
  host.innerHTML = sagas.map((s) => {
    const steps = (s.steps || []).map((st, i) => `${i ? '<span class="saga-arrow">→</span>' : ""}<div class="saga-step ${st.status === "compensated" ? "compensated" : ""}"><span class="pill s-${st.status}" style="padding:1px 7px">${st.status}</span>${esc(st.name)}</div>`).join("")
    return `<div class="panel" style="padding:16px 18px"><div class="panel-head" style="margin-bottom:6px"><h3>${esc(s.name)} <span class="pill s-${s.status}">${s.status.replace(/_/g, " ")}</span></h3><span class="panel-sub">${esc(s.id)} · ${ago(s.created_at)} ago</span></div>
    ${s.error ? `<div class="r-meta" style="color:#ff8a94;margin:4px 0">${esc(s.error)}</div>` : ""}
    <div class="saga-steps">${steps}</div></div>`
  }).join("")
}

// ============================ APPROVALS ============================
async function renderApprovals(stage) {
  stage.innerHTML = `<div id="apprHost"><div class="skeleton" style="height:160px"></div></div>`
  const items = await api("/api/approvals")
  const host = $("#apprHost")
  if (!items.length) { host.innerHTML = `<div class="empty"><div class="big">✅</div>Inbox zero — no actions are waiting on a human.</div>`; return }
  host.innerHTML = `<div class="approvals-grid">${items.map((a) => `<div class="appr-card" data-id="${esc(a.id)}"><div class="glowtab"></div>
    <h4>${esc(a.tool)}</h4><div class="panel-sub">${esc(a.scope || "no scope")}</div>
    <div class="reason">${esc(a.reason || "This action requires manual approval before it can run.")}</div>
    <div class="meta"><span>💰 ${money(a.cost)}</span><span>⏱ ${ago(a.created_at)} ago</span></div>
    <div class="appr-actions"><button class="btn approve" data-do="approve">Approve</button><button class="btn reject" data-do="reject">Reject</button></div></div>`).join("")}</div>`
  host.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-do]"); if (!btn) return
    const card = btn.closest(".appr-card"); const id = card.dataset.id; const approve = btn.dataset.do === "approve"
    card.style.pointerEvents = "none"
    await api(`/api/approvals/${encodeURIComponent(id)}/${approve ? "approve" : "reject"}`, { method: "POST" })
    card.classList.add("resolved")
    toast(approve ? "ok" : "bad", approve ? "Approved" : "Rejected", card.querySelector("h4").textContent)
    setTimeout(() => { card.style.transition = ".4s"; card.style.opacity = "0"; card.style.transform = "scale(.96)"; setTimeout(() => { card.remove(); if (!$(".appr-card")) renderApprovals(stage) }, 400) }, 700)
    refreshBadges()
  })
}

// ============================ LIVE STREAM (SSE) ============================
function connectStream() {
  const es = new EventSource("/api/stream")
  es.addEventListener("hello", (e) => { const d = JSON.parse(e.data); setMode(d.mode) })
  es.addEventListener("pulse", (e) => { onPulse(JSON.parse(e.data)) })
  es.addEventListener("approval", () => refreshBadges())
  es.onerror = () => { $("#liveDot").classList.add("stale") }
  es.onopen = () => { $("#liveDot").classList.remove("stale") }
}
async function onPulse(ov) {
  state.overview = ov; state.lastPulse = Date.now()
  setHealth(ov.kpis.successRate)
  setBadges(ov)
  if (state.view === "overview") {
    bumpKpis(ov); paintThroughput(ov.throughput); paintDonut(ov.actionsByStatus)
    const runs = await api("/api/runs?limit=22")
    mergeFeed(runs)
  }
}
function mergeFeed(runs) {
  const host = $("#feed"); if (!host) return
  const fresh = runs.filter((r) => !state.seenRuns.has(r.id))
  fresh.reverse().forEach((r) => {
    state.seenRuns.add(r.id)
    const div = document.createElement("div"); div.innerHTML = feedRow(r)
    const row = div.firstChild; row.classList.add("enter")
    host.prepend(row)
    if (fresh.length <= 4) toast("info", r.tool, (r.scope || "") + " · " + r.status)
  })
  while (host.children.length > 30) host.lastChild.remove()
}

// ============================ CHROME: badges, health, mode, toasts ============================
function setMode(mode) {
  const pill = $("#modePill"); pill.className = "mode-pill " + mode
  pill.querySelector("span").textContent = mode === "postgres" ? "Live · Neon" : "Demo data"
}
function setHealth(rate) {
  const pct = Math.round((rate ?? 1) * 100)
  $("#railHealthPct").textContent = pct + "%"
  const col = pct >= 95 ? "#34e3a5" : pct >= 80 ? "#ffb347" : "#ff5d6c"
  $("#railRing").style.background = `conic-gradient(${col} ${pct * 3.6}deg, rgba(255,255,255,.08) 0deg)`
}
function setBadges(ov) {
  setBadge("runs", ov.kpis.running)
  setBadge("workflows", ov.kpis.activeWorkflows)
  setBadge("approvals", ov.kpis.awaitingApproval, true)
}
function setBadge(name, n, alert) {
  const el = $(`[data-badge="${name}"]`); if (!el) return
  el.textContent = n; el.classList.toggle("show", n > 0)
}
async function refreshBadges() { const ov = await api("/api/overview"); state.overview = ov; setBadges(ov); setHealth(ov.kpis.successRate) }
function toast(kind, title, sub) {
  const t = document.createElement("div"); t.className = "toast " + kind
  t.innerHTML = `<span class="dot"></span><div><b>${esc(title)}</b><br><span>${esc(sub || "")}</span></div>`
  $("#toasts").appendChild(t)
  setTimeout(() => { t.style.transition = ".4s"; t.style.opacity = "0"; t.style.transform = "translateX(40px)"; setTimeout(() => t.remove(), 400) }, 3400)
}

// ============================ COMMAND PALETTE ============================
const PALETTE = [
  { ic: "◉", label: "Overview", sub: "go", act: () => go("overview") },
  { ic: "⚡", label: "Action Ledger", sub: "go", act: () => go("runs") },
  { ic: "✨", label: "Workflows", sub: "go", act: () => go("workflows") },
  { ic: "⚛", label: "Sagas", sub: "go", act: () => go("sagas") },
  { ic: "✋", label: "Approvals", sub: "go", act: () => go("approvals") },
]
let palSel = 0
function openPalette() { $("#paletteWrap").hidden = false; $("#paletteInput").value = ""; palSel = 0; paintPalette(""); $("#paletteInput").focus() }
function closePalette() { $("#paletteWrap").hidden = true }
function paintPalette(q) {
  const items = PALETTE.filter((p) => p.label.toLowerCase().includes(q.toLowerCase()))
  $("#paletteList").innerHTML = items.map((p, i) => `<div class="p-item ${i === palSel ? "sel" : ""}" data-i="${i}"><span class="ic">${p.ic}</span>${esc(p.label)}<span class="sub">${p.sub}</span></div>`).join("")
  $("#paletteList")._items = items
}
$("#cmdBtn").addEventListener("click", openPalette)
$("#paletteInput").addEventListener("input", (e) => { palSel = 0; paintPalette(e.target.value) })
$("#paletteList").addEventListener("click", (e) => { const it = e.target.closest(".p-item"); if (it) { $("#paletteList")._items[+it.dataset.i].act(); closePalette() } })
addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("#paletteWrap").hidden ? openPalette() : closePalette() }
  else if (!$("#paletteWrap").hidden) {
    const items = $("#paletteList")._items || []
    if (e.key === "Escape") closePalette()
    else if (e.key === "ArrowDown") { e.preventDefault(); palSel = Math.min(palSel + 1, items.length - 1); paintPalette($("#paletteInput").value) }
    else if (e.key === "ArrowUp") { e.preventDefault(); palSel = Math.max(palSel - 1, 0); paintPalette($("#paletteInput").value) }
    else if (e.key === "Enter") { items[palSel]?.act(); closePalette() }
  }
  else if (e.key >= "1" && e.key <= "5" && !/input|textarea/i.test(document.activeElement.tagName)) {
    go(["overview", "runs", "workflows", "sagas", "approvals"][+e.key - 1])
  }
})
$("#paletteWrap").addEventListener("click", (e) => { if (e.target.id === "paletteWrap") closePalette() })

// ============================ BOOT ============================
async function boot() {
  const meta = await api("/api/meta"); setMode(meta.mode)
  const ov = await api("/api/overview"); state.overview = ov
  setHealth(ov.kpis.successRate); setBadges(ov)
  go("overview")
  connectStream()
  // freshness watchdog
  setInterval(() => { if (Date.now() - state.lastPulse > 6000) $("#liveDot").classList.add("stale") }, 3000)
}
boot()
