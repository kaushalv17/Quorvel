/**
 * Belay Phase 3 demo: a checkout saga. charge -> reserve inventory -> ship.
 * Shipping fails, so Belay AUTOMATICALLY rolls back the reservation and the
 * charge — in reverse order, exactly once. No orphaned money, no orphaned stock.
 *
 * Run it:  pnpm demo:saga
 */
import { createSaga } from "../packages/core/src/saga.js"
import { InMemoryLedger } from "../packages/core/src/ledger.js"
import { InMemorySagaStore } from "../packages/core/src/saga-store.js"
import { SagaAbortedError } from "../packages/core/src/errors.js"

// --- fake "external services" with real, observable side effects ---
const world = { charged: 0, refunded: 0, reserved: 0, released: 0, shipments: 0 }

async function chargeCard(amount: number) {
  world.charged += amount
  console.log(`  💳 charged $${amount}`)
  return { chargeId: "ch_777", amount }
}
async function refundCard(chargeId: string, amount: number) {
  world.refunded += amount
  console.log(`  ↩️  refunded $${amount} for ${chargeId}`)
}
async function reserveInventory(sku: string) {
  world.reserved += 1
  console.log(`  📦 reserved 1x ${sku}`)
  return { reservationId: "rsv_1", sku }
}
async function releaseInventory(reservationId: string) {
  world.released += 1
  console.log(`  📤 released reservation ${reservationId}`)
}
async function shipOrder() {
  console.log(`  🚚 contacting carrier...`)
  throw new Error("carrier API timeout")
}

async function main() {
  const ledger = new InMemoryLedger()
  const store = new InMemorySagaStore()

  const checkout = createSaga("checkout", { ledger, store })
    .step({
      name: "charge",
      do: async () => chargeCard(250),
      undo: async (out) => refundCard((out as any).chargeId, (out as any).amount),
    })
    .step({
      name: "reserve",
      do: async () => reserveInventory("WIDGET-1"),
      undo: async (out) => releaseInventory((out as any).reservationId),
    })
    .step({
      name: "ship",
      do: async () => shipOrder(), // 💥 this one fails
    })

  console.log("Agent runs checkout saga (charge -> reserve -> ship)...\n")
  try {
    await checkout.run({ sagaId: "order-1001", input: { sku: "WIDGET-1" } })
    console.log("order completed")
  } catch (err) {
    if (err instanceof SagaAbortedError) {
      console.log(`\n⏪ saga aborted at "${err.failedStep}" (${err.cause})`)
      console.log(`   auto-rolled back: ${err.compensated.join(" -> ")}`)
    } else throw err
  }

  console.log("\n--- world state after rollback ---")
  console.log(`  charged $${world.charged}, refunded $${world.refunded}  => net $${world.charged - world.refunded}`)
  console.log(`  reserved ${world.reserved}, released ${world.released}  => net ${world.reserved - world.released}`)
  console.log(`  shipments: ${world.shipments}`)

  // Re-run the SAME saga id: compensation must NOT run a second time.
  try {
    await checkout.run({ sagaId: "order-1001", input: { sku: "WIDGET-1" } })
  } catch (err) {
    if (!(err instanceof SagaAbortedError)) throw err
  }
  console.log(
    `\n🎉 After re-running the same saga id: refunded still $${world.refunded}, ` +
      `released still ${world.released} (compensation ran EXACTLY once)`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
