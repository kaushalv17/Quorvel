-- Quorvel durable workflow schema (Phase 4)
-- Run after 001_init.sql, 002_policy.sql and 003_saga.sql.

create table if not exists belay_workflows (
  id           bigserial primary key,
  workflow_id  text not null unique,
  name         text not null,
  status       text not null default 'running',
    -- running | suspended | completed | failed
  input        jsonb,
  result       jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Append-only event history. (workflow_id, seq) is the deterministic position
-- of each ctx.* command; it is unique so a retried replay can never rewrite it.
create table if not exists belay_workflow_events (
  id           bigserial primary key,
  workflow_id  text not null references belay_workflows(workflow_id) on delete cascade,
  seq          integer not null,
  type         text not null,
    -- step | sleep | signal | now | random
  name         text not null,
  status       text not null default 'completed',
    -- pending | completed
  result       jsonb,
  fire_at      bigint, -- epoch-ms a sleep timer should fire (sleep events only)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (workflow_id, seq)
);

-- Inbox for signals that arrive before the workflow waits for them.
create table if not exists belay_workflow_signals (
  id           bigserial primary key,
  workflow_id  text not null references belay_workflows(workflow_id) on delete cascade,
  name         text not null,
  payload      jsonb,
  consumed     boolean not null default false,
  created_at   timestamptz not null default now()
);

create index if not exists belay_workflows_status_idx on belay_workflows (status);
create index if not exists belay_workflow_events_due_idx
  on belay_workflow_events (type, status, fire_at);
create index if not exists belay_workflow_signals_inbox_idx
  on belay_workflow_signals (workflow_id, name, consumed);
