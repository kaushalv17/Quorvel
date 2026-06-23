-- Quorvel saga / compensation schema (Phase 3)
-- Run after 001_init.sql and 002_policy.sql.

create table if not exists belay_sagas (
  id           bigserial primary key,
  saga_id      text not null unique,
  name         text not null,
  status       text not null default 'running',
    -- running | awaiting_step | succeeded | compensating | compensated | compensation_failed
  input        jsonb,
  current_step integer not null default 0,
  failed_step  text,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists belay_saga_steps (
  id          bigserial primary key,
  saga_id     text not null references belay_sagas(saga_id) on delete cascade,
  step_index  integer not null,
  name        text not null,
  status      text not null default 'pending',
    -- pending | succeeded | compensated | compensation_failed
  output      jsonb,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (saga_id, step_index)
);

create index if not exists belay_sagas_status_idx on belay_sagas (status);
create index if not exists belay_saga_steps_saga_idx on belay_saga_steps (saga_id);
