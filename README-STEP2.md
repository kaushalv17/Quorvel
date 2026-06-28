# Step 2 - Neon org / membership schema (multi-tenancy foundation)

## What changed (apps/api/src)
- schema.ts   : + orgs.clerk_org_id (unique), + memberships table (+ index). Idempotent.
- types.ts    : Org.clerkOrgId; new Membership / ProvisionOrgInput / ProvisionOrgResult.
- store.ts    : Store interface + MemStore: linkClerkOrg, getOrgByClerkId,
                upsertMembership, getMembership, listMembershipsByUser/ByOrg.
- pgStore.ts  : same methods on the Postgres store (+ clerk_org_id on insert/get org).
- service.ts  : provisionOrg() - idempotent "Clerk org -> Quorvel org + owner + key".

No HTTP route yet (that is Step 3: the Clerk webhook that calls provisionOrg).
The migration auto-applies on the next Render deploy - nothing to run by hand for the schema.

## How to apply
1. Unzip at your repo root (overwrites only apps/api/src/* + adds apps/api/db/*).
   git status should show exactly 5 changed files + 2 new files.
2. Commit & push -> Render redeploys -> migrate() creates the new column + table.
3. In Neon, run apps/api/db/backfill-clerk-org.sql (fill in your Clerk Org ID + User ID).
