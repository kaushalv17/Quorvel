// Idempotent DDL for the Belay Cloud ledger. Applied at boot by migrate().
export const SCHEMA_SQL = `
create table if not exists orgs (
  id          text primary key,
  name        text not null,
  plan        text not null default 'free',
  created_at  timestamptz not null default now()
);

create table if not exists api_keys (
  id           text primary key,
  org_id       text not null references orgs(id) on delete cascade,
  key_hash     text not null unique,
  key_prefix   text not null,
  name         text not null default 'default',
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create table if not exists belay_actions (
  org_id           text not null references orgs(id) on delete cascade,
  idempotency_key  text not null,
  scope            text,
  tool             text not null,
  args             jsonb,
  cost             float8 not null default 0,
  status           text not null default 'pending',
  result           jsonb,
  error            text,
  reason           text,
  attempts         int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (org_id, idempotency_key)
);

create index if not exists belay_actions_status_idx on belay_actions (org_id, status, created_at);
create index if not exists belay_actions_scope_idx  on belay_actions (org_id, scope);
create index if not exists belay_actions_recent_idx on belay_actions (org_id, created_at desc);

-- Part 9: monthly metered-usage counters per org.
create table if not exists usage_counters (
  org_id  text not null references orgs(id) on delete cascade,
  period  text not null,
  count   bigint not null default 0,
  primary key (org_id, period)
);
`
