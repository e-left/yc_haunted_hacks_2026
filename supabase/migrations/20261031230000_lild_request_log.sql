-- One row per incoming request, for review and for improving the system.
-- Unlike the audit tables, this keeps raw request text, so treat it as sensitive.
-- Tokens are removed in code before anything is written here.

create table lild.request_log (
  request_id text primary key references lild.requests (request_id),
  event_id text not null,
  merchant_id uuid not null references public.merchants (id),
  sender text not null,
  request_text text not null,
  status text not null default 'pending',  -- pending, active, refused, error, expired
  status_code text,                        -- refusal or error code
  planner_output jsonb,
  plan jsonb,
  plan_hash text,
  review jsonb,
  reply jsonb,                             -- what was sent back, with the token removed
  api_id text,
  actor_class text,
  actor_id text,
  api_url text,
  contract jsonb,
  expires_at timestamptz,
  invocation_count integer not null default 0,
  last_invoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index request_log_created_idx on lild.request_log (created_at desc);
create index request_log_status_idx on lild.request_log (status);

alter table lild.request_log enable row level security;
grant select, insert, update on lild.request_log to lild_recorder;
create policy lild_recorder_all on lild.request_log for all to lild_recorder using (true) with check (true);
