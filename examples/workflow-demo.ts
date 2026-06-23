/**
 * Quorvel Phase 4 demo: a durable "deep research" agent workflow that SURVIVES A
 * CRASH. The workflow:
 *   plan -> gather -> sleep (rate-limit cooldown) -> wait for human approval -> publish
 *
 * Half-way through we throw away the engine instance (simulating a process
 * crash / redeploy) and rebuild a fresh engine against the SAME store. The
 * workflow resumes from its last durable checkpoint — committed steps never
 * re-run, money/effects are never duplicated.
 *
 * Run it:  pnpm demo:workflow
 */
import { WorkflowEngine, defineWorkflow } from "../packages/core/src/workflow.js"
import { InMemoryWorkflowStore } from "../packages/core/src/workflow-store.js"

// A controllable clock so the durable "1 hour" sleep fires instantly in the demo.
const clock = { t: Date.parse("2026-06-19T10:00:00Z") }
const HOUR = 3600_000

// Side effects with observable counters, to PROVE each step runs exactly once.
const world = { plans: 0, gathers: 0, publishes: 0 }

const research = defineWorkflow<{ topic: string }, { url: string; sources: number }>(
  "deep-research",
  async (ctx, input) => {
    const plan = await ctx.step("plan", async () => {
      world.plans++
      console.log(`  🧭 planned research for "${input.topic}"`)
      return { sections: ["background", "market", "risks"] }
    })

    const gathered = await ctx.step("gather", async () => {
      world.gathers++
      console.log(`  🔎 gathered sources for ${plan.sections.length} sections`)
      return { sources: 12 }
    })

    // Durable cooldown: survives restarts. No timer is held in memory.
    console.log("  ⏳ cooling down for 1h (rate limits)... [SUSPENDS]")
    await ctx.sleep("cooldown", HOUR)

    // Human-in-the-loop gate: the workflow parks until someone approves.
    console.log("  🙋 waiting for a human to approve publishing... [SUSPENDS]")
    const decision = await ctx.waitForSignal<{ approved: boolean }>("publish-approval")
    if (!decision.approved) {
      console.log("  🛑 human rejected publishing")
      return { url: "", sources: gathered.sources }
    }

    const published = await ctx.step("publish", async () => {
      world.publishes++
      console.log("  📤 published report")
      return { url: "https://reports.example/deep-research-1" }
    })

    return { url: published.url, sources: gathered.sources }
  },
)

async function main() {
  // One durable store; engines come and go (like real processes).
  const store = new InMemoryWorkflowStore()
  const id = "research-42"

  console.log("=== process #1 boots, starts the workflow ===")
  const engine1 = new WorkflowEngine({ store, clock: () => clock.t })
  engine1.register(research)
  let run = await engine1.start("deep-research", {
    workflowId: id,
    input: { topic: "durable agents" },
  })
  console.log(`  status -> ${run.status}\n`)

  console.log("=== 💥 process #1 CRASHES (engine1 is gone) ===\n")

  console.log("=== process #2 boots fresh against the same store ===")
  const engine2 = new WorkflowEngine({ store, clock: () => clock.t })
  engine2.register(research)

  // An hour passes; a background tick fires the durable timer and resumes.
  clock.t += HOUR
  const fired = await engine2.tick()
  run = (await engine2.getRun(id))!
  console.log(`  tick fired ${fired} timer(s); status -> ${run.status}\n`)

  console.log("=== a human clicks Approve in the dashboard ===")
  run = await engine2.signal(id, "publish-approval", { approved: true })
  console.log(`  status -> ${run.status}`)
  console.log(`  result -> ${JSON.stringify(run.result)}\n`)

  console.log("--- effect counters (each must be exactly 1) ---")
  console.log(`  plans=${world.plans}  gathers=${world.gathers}  publishes=${world.publishes}`)

  // Idempotent re-drive: replaying a completed workflow does nothing.
  await engine2.start("deep-research", { workflowId: id, input: { topic: "durable agents" } })
  console.log(
    `\n🎉 After a crash + resume + re-run: plans=${world.plans}, gathers=${world.gathers}, ` +
      `publishes=${world.publishes} (every side effect ran EXACTLY once)`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
