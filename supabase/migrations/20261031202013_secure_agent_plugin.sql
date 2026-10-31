-- A dedicated Supabase Auth user is bound to one merchant by trusted admin code.
-- No identity or approval is seeded: until provisioned, every call fails closed.
create table public.lild_plugin_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  merchant_id uuid not null unique references public.merchants(id),
  enabled boolean not null default true,
  unique (user_id, merchant_id)
);

-- This fixed plan returns asin, brand, and name only for the specified products.
-- Only trusted administrative code may create or revoke an approval.
create table public.lild_plugin_approvals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  merchant_id uuid not null,
  product_ids uuid[] not null check (cardinality(product_ids) between 1 and 1000 and array_position(product_ids, null) is null),
  max_results integer not null check (max_results between 1 and 100),
  purpose text not null check (length(btrim(purpose)) between 1 and 300),
  status text not null check (status in ('approved', 'revoked')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (user_id, merchant_id) references public.lild_plugin_accounts(user_id, merchant_id) on delete cascade
);
create index lild_plugin_approvals_account_idx on public.lild_plugin_approvals(user_id, merchant_id);

create table public.lild_plugin_invocations (
  id uuid primary key default gen_random_uuid(),
  approval_id uuid not null,
  user_id uuid not null,
  result_count integer not null check (result_count >= 0),
  occurred_at timestamptz not null default now()
);

alter table public.lild_plugin_accounts enable row level security;
alter table public.lild_plugin_approvals enable row level security;
alter table public.lild_plugin_invocations enable row level security;
revoke all on public.lild_plugin_accounts, public.lild_plugin_approvals,
  public.lild_plugin_invocations from public, anon, authenticated;

-- The functions run as this non-login, non-bypass role, not as the database
-- owner. It has only the exact column grants needed for these functions.
create role lild_plugin_executor nologin noinherit nobypassrls;
grant lild_plugin_executor to current_user;
grant usage, create on schema public to lild_plugin_executor;
grant usage on schema auth to lild_plugin_executor;
grant execute on function auth.uid() to lild_plugin_executor;
grant select (user_id, merchant_id, enabled) on public.lild_plugin_accounts to lild_plugin_executor;
grant select (id, user_id, merchant_id, product_ids, max_results, status, expires_at)
  on public.lild_plugin_approvals to lild_plugin_executor;
grant select (merchant_id, resource, field_name, category)
  on public.data_classifications to lild_plugin_executor;
grant select (id, merchant_id, asin, brand, name) on public.products to lild_plugin_executor;
grant insert (approval_id, user_id, result_count) on public.lild_plugin_invocations to lild_plugin_executor;

create policy lild_plugin_executor_read on public.lild_plugin_accounts for select to lild_plugin_executor using (true);
create policy lild_plugin_executor_read on public.lild_plugin_approvals for select to lild_plugin_executor using (true);
create policy lild_plugin_executor_read on public.data_classifications for select to lild_plugin_executor using (true);
create policy lild_plugin_executor_read on public.products for select to lild_plugin_executor using (true);
create policy lild_plugin_executor_add on public.lild_plugin_invocations for insert to lild_plugin_executor with check (true);

create function public.lild_plugin_planning_fields()
returns table (resource text, field_name text)
language plpgsql security definer set search_path = ''
as $$
declare agent_id uuid := auth.uid();
begin
  if agent_id is null or not exists (
    select 1 from public.lild_plugin_accounts a where a.user_id = agent_id and a.enabled
  ) then
    raise exception using errcode = '42501', message = 'Agent access denied';
  end if;
  return query
    select c.resource, c.field_name
    from public.lild_plugin_accounts a
    join public.data_classifications c on c.merchant_id = a.merchant_id
    where a.user_id = agent_id and a.enabled and c.category = 'reviewable'
    order by c.resource, c.field_name;
end;
$$;

create function public.lild_plugin_read_products(approval_id uuid)
returns table (asin text, brand text, name text)
language plpgsql security definer set search_path = ''
as $$
declare
  agent_id uuid := auth.uid();
  scope record;
  n integer;
begin
  select a.id, a.merchant_id, a.product_ids, a.max_results into scope
  from public.lild_plugin_approvals a
  join public.lild_plugin_accounts account on account.user_id = a.user_id
    and account.merchant_id = a.merchant_id and account.enabled
  where a.id = approval_id and a.user_id = agent_id
    and a.status = 'approved' and a.expires_at > statement_timestamp();
  if not found then
    raise exception using errcode = '42501', message = 'Agent access denied';
  end if;

  -- Fields used for filtering and joining are also subject to classification.
  if (select count(*) from public.data_classifications c
      where c.merchant_id = scope.merchant_id and c.resource = 'products'
        and c.field_name = any (array['id','merchant_id','asin','brand','name'])
        and c.category = 'reviewable') <> 5 then
    raise exception using errcode = '42501', message = 'Agent access denied';
  end if;

  return query
    select p.asin, p.brand, p.name from public.products p
    where p.merchant_id = scope.merchant_id and p.id = any (scope.product_ids)
    order by p.id limit scope.max_results;
  get diagnostics n = row_count;
  insert into public.lild_plugin_invocations (approval_id, user_id, result_count)
    values (scope.id, agent_id, n);
end;
$$;

alter function public.lild_plugin_planning_fields() owner to lild_plugin_executor;
alter function public.lild_plugin_read_products(uuid) owner to lild_plugin_executor;
revoke create on schema public from lild_plugin_executor;
revoke all on function public.lild_plugin_planning_fields() from public, anon, authenticated, service_role;
revoke all on function public.lild_plugin_read_products(uuid) from public, anon, authenticated, service_role;
grant execute on function public.lild_plugin_planning_fields() to authenticated;
grant execute on function public.lild_plugin_read_products(uuid) to authenticated;
