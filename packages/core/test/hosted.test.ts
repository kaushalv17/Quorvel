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