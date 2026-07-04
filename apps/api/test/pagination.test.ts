// Keyset/cursor pagination tests (MemStore mirrors PgStore keyset semantics).
import assert from "node:assert/strict"
import { MemStore, decodeCursor } from "../src/store"
import type { ActionCursor } from "../src/store"

async function seed(store: MemStore, orgId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await store.insertPending(orgId, {
      idempotencyKey: `k-${String(i).padStart(3, "0")}`,
      scope: null,
      tool: "demo",
      cost: 1,
    })
  }
}

async function drain(
  fetchPage: (
    cursor: ActionCursor | null,
  ) => Promise<{ items: Array<{ idempotencyKey: string }>; nextCursor: string | null }>,
): Promise<string[]> {
  const seen: string[] = []
  let cursor: ActionCursor | null = null
  for (let guard = 0; guard < 1000; guard++) {
    const page = await fetchPage(cursor)
    for (const r of page.items) seen.push(r.idempotencyKey)
    if (!page.nextCursor) return seen
    cursor = decodeCursor(page.nextCursor)
  }
  throw new Error("pagination did not terminate")
}

let passed = 0
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn()
  passed++
  console.log(`  ok - ${name}`)
}

console.log("keyset pagination tests")

await test("pages through all recent actions with no gaps or duplicates", async () => {
  const store = new MemStore()
  await seed(store, "org1", 7)
  const seen = await drain((cursor) => store.pageRecent("org1", { limit: 2, cursor }))
  assert.equal(seen.length, 7)
  assert.equal(new Set(seen).size, 7)
})

await test("recent order is newest-first by (createdAt, idempotencyKey)", async () => {
  const store = new MemStore()
  await seed(store, "o", 5)
  const page = await store.pageRecent("o", { limit: 10 })
  const keys = page.items.map((r) => r.idempotencyKey)
  const expected = [...keys].sort((a, b) => b.localeCompare(a))
  assert.deepEqual(keys, expected)
  assert.equal(page.nextCursor, null)
})

await test("pageByStatus filters and pages ascending", async () => {
  const store = new MemStore()
  await seed(store, "o", 6)
  for (const i of [0, 2, 4]) {
    await store.applyTransition("o", `k-${String(i).padStart(3, "0")}`, {
      status: "failed",
    })
  }
  const seen = await drain((cursor) => store.pageByStatus("o", "failed", { limit: 1, cursor }))
  assert.deepEqual(seen, ["k-000", "k-002", "k-004"])
})

await test("scopes pages to the requested org", async () => {
  const store = new MemStore()
  await seed(store, "a", 3)
  await seed(store, "b", 2)
  const page = await store.pageRecent("a", { limit: 100 })
  assert.equal(page.items.length, 3)
})

await test("rejects a malformed cursor", async () => {
  assert.throws(() => decodeCursor(Buffer.from("notadate|k1", "utf8").toString("base64url")))
})

console.log(`\n${passed} passed`)