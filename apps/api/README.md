# @belay/cloud-api

The hosted **Belay Cloud** ledger service — a Fastify REST API that implements
`@belay/core`'s `LedgerStore` contract over Postgres, with API-key auth and
per-organization isolation. It is the server behind the SDK's hosted mode:

```ts
// local
const ledger = new InMemoryLedger()
// hosted — the only change
const ledger = new HostedLedger({ apiKey: process.env.BELAY_API_KEY! })
```

Because the API mirrors `LedgerStore` 1:1, the hosted backend behaves identically
to the in-process ledger — verified by a shared contract test suite run against
both `InMemoryLedger` and `HostedLedger`.

## Architecture

```
SDK (HostedLedger) --HTTPS + API key--> Cloud API
                                          |
                              router.handleRequest  (framework-agnostic)
                                          |
                                    BelayCloudService
                                          |
                                        Store
                                    /          \
                              MemStore        PgStore (Postgres)
```

- **Router** (`src/router.ts`) is a pure `handleRequest(svc, adminSecret, req)`
  function: HTTP in, `{ status, body }` out. Both the Fastify server and the
  HostedLedger round-trip tests call it, so the code under test is the code that
  serves traffic.
- **Service** (`src/service.ts`) holds business logic, framework-agnostic, and
  exposes the `LedgerStore` surface scoped per org. Talks only to a `Store`.
- **Store** (`src/store.ts`) is the storage seam: `MemStore` for tests/local,
  `PgStore` (`src/pgStore.ts`) for production. A queue (BullMQ) can later sit in
  front of the same seam without touching routes or logic.
- **Server** (`src/server.ts`) is a thin Fastify adapter that forwards every
  request to `handleRequest`.

## Run

```bash
# in-memory (no DB) — great for a smoke test
BELAY_ADMIN_SECRET=dev pnpm --filter @belay/cloud-api start

# with Postgres
DATABASE_URL=postgres://... BELAY_ADMIN_SECRET=dev pnpm --filter @belay/cloud-api start
```

## Endpoints

Every `/v1` route except `POST /v1/keys` requires `Authorization: Bearer <key>`
and is scoped to that key's org. Action routes map 1:1 to `LedgerStore` methods.

| Method | Path | Auth | LedgerStore method |
| --- | --- | --- | --- |
| GET | `/health` | none | — (liveness) |
| POST | `/v1/keys` | `x-admin-secret` | — (mint org API key) |
| POST | `/v1/actions` | Bearer | `insertPending` → `{ inserted, existing? }` |
| GET | `/v1/actions/:key` | Bearer | `get` (200, or 404 → `undefined`) |
| GET | `/v1/actions?status=&limit=` | Bearer | `listByStatus` |
| POST | `/v1/stats` | Bearer | `stats` (`{ scope, tool?, since? }`) |
| POST | `/v1/actions/:key/running` | Bearer | `markRunning` (attempts +1) |
| POST | `/v1/actions/:key/succeeded` | Bearer | `markSucceeded` (`{ result }`) |
| POST | `/v1/actions/:key/failed` | Bearer | `markFailed` (`{ error }`) |
| POST | `/v1/actions/:key/awaiting-approval` | Bearer | `markAwaitingApproval` (`{ reason }`) |
| POST | `/v1/actions/:key/approved` | Bearer | `markApproved` |
| POST | `/v1/actions/:key/rejected` | Bearer | `markRejected` (`{ reason }`) |
| POST | `/v1/actions/:key/denied` | Bearer | `markDenied` (`{ reason }`) |

The approval inbox is simply `GET /v1/actions?status=awaiting_approval`.
Transition routes are idempotent no-ops when the key does not exist, matching
`InMemoryLedger`/`PostgresLedger`.

## Auth

Keys look like `bly_live_<random>`. Only the SHA-256 hash is stored; the
plaintext is shown once at creation. Requests send `Authorization: Bearer <key>`.
Every row is scoped to the key's `org_id`, so tenants are isolated.

## Tests

```bash
pnpm --filter @belay/cloud-api test       # service + router tests (MemStore)
pnpm --filter @belay/cloud-api typecheck  # tsc --noEmit over src
```
