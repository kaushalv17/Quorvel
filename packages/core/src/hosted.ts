/**
 * HostedLedger: a LedgerStore backed by Quorvel Cloud over HTTP.
 *
 * This is the one-line switch from local to hosted. Anywhere you'd construct an
 * InMemoryLedger or PostgresLedger, construct a HostedLedger with your API key
 * instead and every guard, budget, idempotency check, and approval flows
 * through the hosted service — no other code changes.
 *
 *   const ledger = new HostedLedger({ apiKey: process.env.QUORVEL_API_KEY! })
 *
 * Transport is the platform-native `fetch` (Node 18+, Bun, Deno, browsers,
 * edge). No dependencies. Inject `fetch` for tests or exotic runtimes.
 */
import type {
  ActionRecord,
  ActionStatus,
  InsertPendingInput,
  InsertResult,
  LedgerStore,
  Stats,
  StatsFilter,
} from "./ledger.js"

export interface HostedLedgerOptions {
  /** Quorvel API key (e.g. "qrv_live_..."). Sent as a Bearer token. */
  apiKey: string
  /** Base URL of the Quorvel Cloud API. Defaults to https://api.quorvel.tech. */
  baseUrl?: string
  /** Override the fetch implementation (tests, custom runtimes). */
  fetch?: typeof fetch
}

/** A page of action records plus the opaque cursor for the next page (null when exhausted). */
export interface ActionPage {
  items: ActionRecord[]
  nextCursor: string | null
}

/** Thrown when the hosted API returns an unexpected (non-handled) status. */
export class HostedLedgerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = "HostedLedgerError"
  }
}

export class HostedLedger implements LedgerStore {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: HostedLedgerOptions) {
    if (!opts || !opts.apiKey) {
      throw new Error("HostedLedger: apiKey is required")
    }
    this.apiKey = opts.apiKey
    this.baseUrl = (opts.baseUrl ?? "https://api.quorvel.tech").replace(/\/+$/, "")
    const f = opts.fetch ?? globalThis.fetch
    if (typeof f !== "function") {
      throw new Error(
        "HostedLedger: no fetch available in this runtime; pass options.fetch",
      )
    }
    // Bind so we don't trip `Illegal invocation` on the global.
    this.fetchImpl = f.bind(globalThis) as typeof fetch
  }

  // --- LedgerStore ---

  async get(key: string): Promise<ActionRecord | undefined> {
    const res = await this.request("GET", `/v1/actions/${enc(key)}`)
    if (res.status === 404) return undefined
    return this.parse<ActionRecord>(res)
  }

  async insertPending(input: InsertPendingInput): Promise<InsertResult> {
    const res = await this.request("POST", "/v1/actions", {
      idempotencyKey: input.idempotencyKey,
      scope: input.scope,
      tool: input.tool,
      args: input.args,
      cost: input.cost,
    })
    return this.parse<InsertResult>(res)
  }

  async markRunning(key: string): Promise<void> {
    await this.transition(key, "running")
  }
  async markSucceeded(key: string, result: unknown): Promise<void> {
    await this.transition(key, "succeeded", { result })
  }
  async markFailed(key: string, error: string): Promise<void> {
    await this.transition(key, "failed", { error })
  }
  async markAwaitingApproval(key: string, reason: string): Promise<void> {
    await this.transition(key, "awaiting-approval", { reason })
  }
  async markApproved(key: string): Promise<void> {
    await this.transition(key, "approved")
  }
  async markRejected(key: string, reason: string): Promise<void> {
    await this.transition(key, "rejected", { reason })
  }
  async markDenied(key: string, reason: string): Promise<void> {
    await this.transition(key, "denied", { reason })
  }

  async listByStatus(
    status: ActionStatus,
    limit?: number,
  ): Promise<ActionRecord[]> {
    const qs = new URLSearchParams({ status })
    if (typeof limit === "number") qs.set("limit", String(limit))
    const res = await this.request("GET", `/v1/actions?${qs.toString()}`)
    return this.parse<ActionRecord[]>(res)
  }

  async pageActions(
    opts: { status?: ActionStatus; limit?: number; cursor?: string } = {},
  ): Promise<ActionPage> {
    const qs = new URLSearchParams()
    if (opts.status) qs.set("status", opts.status)
    if (typeof opts.limit === "number") qs.set("limit", String(opts.limit))
    if (opts.cursor) qs.set("cursor", opts.cursor)
    const query = qs.toString()
    const res = await this.request(
      "GET",
      query ? `/v1/actions/page?${query}` : "/v1/actions/page",
    )
    return this.parse<ActionPage>(res)
  }

  /**
   * Async-iterate every action across all pages, transparently following
   * the opaque cursor. Yields records in server order (newest-first),
   * starting from an optional cursor, and stops when the server returns a
   * null cursor.
   *
   *   for await (const action of ledger.iterateActions({ status: "pending" })) {
   *     // handle action
   *   }
   */
  async *iterateActions(
    opts: { status?: ActionStatus; limit?: number; cursor?: string } = {},
  ): AsyncGenerator<ActionRecord, void, unknown> {
    let cursor = opts.cursor
    do {
      const page = await this.pageActions({
        status: opts.status,
        limit: opts.limit,
        cursor,
      })
      for (const item of page.items) yield item
      cursor = page.nextCursor ?? undefined
    } while (cursor)
  }

  async stats(filter: StatsFilter): Promise<Stats> {
    const res = await this.request("POST", "/v1/stats", {
      scope: filter.scope,
      tool: filter.tool,
      since: filter.since,
    })
    return this.parse<Stats>(res)
  }

  // --- transport ---

  private transition(
    key: string,
    action: string,
    body?: Record<string, unknown>,
  ): Promise<Response> {
    return this.request("POST", `/v1/actions/${enc(key)}/${action}`, body)
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
    }
    let payload: string | undefined
    if (body !== undefined) {
      headers["content-type"] = "application/json"
      payload = JSON.stringify(body)
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: payload,
    })
    // 2xx and 404 are "expected"; everything else is an error we surface.
    if (!res.ok && res.status !== 404) {
      throw await this.toError(res)
    }
    return res
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  private async toError(res: Response): Promise<HostedLedgerError> {
    let message = `Quorvel API ${res.status}`
    let code: string | undefined
    try {
      const data = JSON.parse(await res.text()) as {
        error?: string
        code?: string
      }
      if (data.error) message = data.error
      code = data.code
    } catch {
      // non-JSON body; keep default message
    }
    return new HostedLedgerError(message, res.status, code)
  }
}

function enc(key: string): string {
  return encodeURIComponent(key)
}
