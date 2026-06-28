-- ============================================================================
-- Step 2 backfill: link your existing "demo" org to your Clerk org + owner.
-- Run this in the Neon SQL editor AFTER the API has redeployed on Render
-- (boot runs migrate(), which now adds orgs.clerk_org_id + the memberships table).
--
--   CLERK_ORG_ID  -> Clerk dashboard > Organizations > <your org> > copy "Org ID"  (org_...)
--   CLERK_USER_ID -> Clerk dashboard > Users > <you> > copy "User ID"            (user_...)
-- ============================================================================

update orgs
   set clerk_org_id = 'CLERK_ORG_ID'
 where id = 'org_92f2caf6bba24e5da46e3f3df506c7c3';

insert into memberships (clerk_user_id, org_id, role)
values ('CLERK_USER_ID', 'org_92f2caf6bba24e5da46e3f3df506c7c3', 'owner')
on conflict (clerk_user_id, org_id) do update set role = excluded.role;

-- Verify:
select id, name, plan, clerk_org_id from orgs  where id = 'org_92f2caf6bba24e5da46e3f3df506c7c3';
select *                            from memberships where org_id = 'org_92f2caf6bba24e5da46e3f3df506c7c3';
