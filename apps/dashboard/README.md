# @quorvel/dashboard

Approvals dashboard for **Quorvel** — a Next.js (App Router) UI built entirely on top of the `@quorvel/cloud-api` REST API.

## What it does

- **Live approvals queue** — every action in `awaiting_approval`, with one-click **Approve** / **Reject** (reject captures a reason). Mutations run as React Server Actions that call the REST API and revalidate the page.
- **Per-agent timeline** — actions grouped by scope (agent), with a drill-down view of each agent's recent action history and statuses.
- **Usage bar** — current billing period usage vs. plan limit, straight from `GET /v1/usage`.

Everything is driven through the same REST surface shipped in `@quorvel/cloud-api` — no direct database access.

## Configure

Copy `.env.example` to `.env.local` and set:

```
QUORVEL_API_URL=http://localhost:8080
QUORVEL_API_KEY=qrv_live_...   # minted via POST /v1/keys on the cloud API
```

## Develop

```bash
pnpm install
pnpm --filter @quorvel/dashboard dev      # http://localhost:3000
```

## Test & typecheck

The API client (`lib/belay.ts`) is covered by zero-dependency contract tests that
run against a fake `fetch`, so no network or running API is required:

```bash
pnpm --filter @quorvel/dashboard test       # tsx test/lib.test.ts
pnpm --filter @quorvel/dashboard typecheck  # tsc -p tsconfig.sandbox.json
```

## Layout

| Path | Purpose |
| --- | --- |
| `lib/belay.ts` | Typed `QuorvelClient` (injectable fetch) + `groupByScope` |
| `lib/server-client.ts` | Server-only client built from env vars |
| `app/page.tsx` | Approvals queue + usage bar |
| `app/actions.ts` | `approve` / `reject` server actions |
| `app/agents/page.tsx` | Agents grouped by scope |
| `app/agents/[scope]/page.tsx` | Per-agent action timeline |
| `components/StatusBadge.tsx` | Status pill |
