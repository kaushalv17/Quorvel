import { describe, it, expect } from "vitest"
import { HostedLedger } from "../src/hosted.js"

type Capture = { url?: string; init?: any }

function makeFetch(status: number, body: unknown, cap: Capture): typeof fetch {
  return (async (url: any, init: any) => {
    cap.url = String(url)
    cap.init = init
    const text = body === undefined ? "" : JSON.stringify(body)
    return new Response(text, { status, headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch
}

const opts = (fetchImpl: typeof fetch) => ({
  apiKey: "qrv_live_test",
  baseUrl: "https://api.example.com",
  fetch: fetchImpl,
})

describe("HostedLedger.pageActions", () => {
  it("builds status + limit + cursor query and parses items + nextCursor", async () => {
    const cap: Capture = {}
    const body = {
      items: [
        { idempotencyKey: "k2", scope: null, tool: "t", args: {}, cost: 0, status: "succeeded", attempts: 0, createdAt: "2026-01-02T00:00:00.000Z" },
      ],
      nextCursor: "Y3Vyc29y",
    }
    const ledger = new HostedLedger(opts(makeFetch(200, body, cap)))
    const res = await ledger.pageActions({ status: "succeeded", limit: 50, cursor: "abc123" })
    expect(cap.url).toBe("https://api.example.com/v1/actions/page?status=succeeded&limit=50&cursor=abc123")
    expect(cap.init.method).toBe("GET")
    expect(res.items.length).toBe(1)
    expect(res.items[0].idempotencyKey).toBe("k2")
    expect(res.nextCursor).toBe("Y3Vyc29y")
  })

  it("omits query params that are not provided", async () => {
    const cap: Capture = {}
    const ledger = new HostedLedger(opts(makeFetch(200, { items: [], nextCursor: null }, cap)))
    const res = await ledger.pageActions()
    expect(cap.url).toBe("https://api.example.com/v1/actions/page")
    expect(res.items).toEqual([])
    expect(res.nextCursor).toBe(null)
  })

  it("sends the api key as a bearer token", async () => {
    const cap: Capture = {}
    const ledger = new HostedLedger(opts(makeFetch(200, { items: [], nextCursor: null }, cap)))
    await ledger.pageActions({ limit: 10 })
    expect(cap.url).toBe("https://api.example.com/v1/actions/page?limit=10")
    expect(cap.init.headers.authorization).toBe("Bearer qrv_live_test")
  })

  it("throws HostedLedgerError on a non-ok status", async () => {
    const cap: Capture = {}
    const ledger = new HostedLedger(opts(makeFetch(500, { error: "boom", code: "server_error" }, cap)))
    await expect(ledger.pageActions()).rejects.toMatchObject({ status: 500, code: "server_error" })
  })
})

describe("HostedLedger.iterateActions", () => {
  it("walks the cursor across pages and yields every item, then stops", async () => {
    const urls: string[] = []
    const pages = [
      {
        items: [
          { idempotencyKey: "k1", scope: null, tool: "t", args: {}, cost: 0, status: "pending", attempts: 0, createdAt: "2026-01-01T00:00:00.000Z" },
          { idempotencyKey: "k2", scope: null, tool: "t", args: {}, cost: 0, status: "pending", attempts: 0, createdAt: "2026-01-02T00:00:00.000Z" },
        ],
        nextCursor: "PAGE2",
      },
      {
        items: [
          { idempotencyKey: "k3", scope: null, tool: "t", args: {}, cost: 0, status: "pending", attempts: 0, createdAt: "2026-01-03T00:00:00.000Z" },
        ],
        nextCursor: null,
      },
    ]
    let call = 0
    const fetchImpl = (async (url: any) => {
      urls.push(String(url))
      const text = JSON.stringify(pages[call])
      call++
      return new Response(text, { status: 200, headers: { "content-type": "application/json" } })
    }) as unknown as typeof fetch

    const ledger = new HostedLedger(opts(fetchImpl))
    const seen: string[] = []
    for await (const a of ledger.iterateActions({ status: "pending", limit: 2 })) {
      seen.push(a.idempotencyKey)
    }

    expect(seen).toEqual(["k1", "k2", "k3"])
    expect(call).toBe(2)
    expect(urls[0]).toBe("https://api.example.com/v1/actions/page?status=pending&limit=2")
    expect(urls[1]).toBe("https://api.example.com/v1/actions/page?status=pending&limit=2&cursor=PAGE2")
  })

  it("stops after a single page when nextCursor is null", async () => {
    const cap: Capture = {}
    const body = {
      items: [
        { idempotencyKey: "only", scope: null, tool: "t", args: {}, cost: 0, status: "pending", attempts: 0, createdAt: "2026-01-01T00:00:00.000Z" },
      ],
      nextCursor: null,
    }
    const ledger = new HostedLedger(opts(makeFetch(200, body, cap)))
    const seen: string[] = []
    for await (const a of ledger.iterateActions()) {
      seen.push(a.idempotencyKey)
    }
    expect(seen).toEqual(["only"])
    expect(cap.url).toBe("https://api.example.com/v1/actions/page")
  })
})