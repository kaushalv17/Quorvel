# @belay/dashboard

Approvals dashboard for **Belay** — a Next.js (App Router) UI built entirely on top of the `@belay/cloud-api` REST API.

## What it does

- **Live approvals queue** — every action in `awaiting_approval`, with one-click **Approve** / **Reject** (reject captures a reason). Mutations run as React Server Actions that call the REST API and revalidate the page.
- **Per-agent timeline** — actions grouped by scope (agent), with a drill-down view of each agent's recent action history and statuses.
- **Usage bar** — current billing period usage vs. plan limit, straight from `GET /v1/usage`.

Everything is driven through the same REST surface shipped in `@belay/cloud-api` — no direct database access.

## Configure

Copy `.env.example` to `.env.local` and set:

```
BELAY_API_URL=http://localhost:8080
BELAY_API_KEY=bly_live_...   # minted via POST /v1/keys on the cloud API
```

## Develop

```bash
pnpm install
pnpm --filter @belay/dashboard dev      # http://localhost:3000
```

## Test & typecheck

The API client (`lib/belay.ts`) is covered by zero-dependency contract tests that
run against a fake `fetch`, so no network or running API is required:

```bash
pnpm --filter @belay/dashboard test       # tsx test/lib.test.ts
pnpm --filter @belay/dashboard typecheck  # tsc -p tsconfig.sandbox.json
```

## Layout

| Path | Purpose |
| --- | --- |
| `lib/belay.ts` | Typed `BelayClient` (injectable fetch) + `groupByScope` |
| `lib/server-client.ts` | Server-only client built from env vars |
| `app/page.tsx` | Approvals queue + usage bar |
| `app/actions.ts` | `approve` / `reject` server actions |
| `app/agents/page.tsx` | Agents grouped by scope |
| `app/agents/[scope]/page.tsx` | Per-agent action timeline |
| `components/StatusBadge.tsx` | Status pill |
