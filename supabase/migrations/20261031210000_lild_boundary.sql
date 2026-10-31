-- LI/LD enforcement layer. Additive: the merchant catalog tables are not altered,
-- apart from narrow read policies for the roles below.

create schema lild;     -- audit, catalog and grant registry
create schema lild_api; -- one view per approved API
revoke all on schema lild, lild_api from public;

create table lild.categories (
  merchant_id uuid not null references public.merchants (id),
  name text not null,
  primary key (merchant_id, name)
);

create table lild.requests (
  request_id text primary key,
  event_id text not null unique,
  merchant_id uuid not null references public.merchants (id),
  received_at timestamptz not null,
  state text not null check (state in ('pending', 'active', 'rejected', 'expired')),
  reason text
);

create table lild.apis (
  api_id text primary key,
  request_id text not null references lild.requests (request_id),
  merchant_id uuid not null,
  category text not null,
  purpose text not null,
  plan jsonb not null,
  plan_hash text not null,
  access_categories text[] not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  state text not null check (state in ('pending', 'active', 'rejected', 'expired')),
  foreign key (merchant_id, category) references lild.categories (merchant_id, name)
);

create table lild.interactions (
  id bigint generated always as identity primary key,
  request_id text not null references lild.requests (request_id),
  api_id text, -- review decisions are recorded before the API row exists
  type text not null,
  outcome text not null,
  approver_type text,
  access_category text,
  reason text,
  at timestamptz not null
);

create table lild.grants (
  api_id text primary key,
  role_name text not null unique,
  view_name text not null unique,
  expires_at timestamptz not null
);

alter table lild.categories enable row level security;
alter table lild.requests enable row level security;
alter table lild.apis enable row level security;
alter table lild.interactions enable row level security;
alter table lild.grants enable row level security;

create role lild_view_owner nologin nobypassrls;  -- owns per-API views; reads reviewable tables only
create role lild_provisioner nologin createrole nobypassrls; -- manages per-API login roles
create role lild_recorder nologin nobypassrls;    -- writes audit and catalog; reads classifications

grant lild_view_owner, lild_provisioner, lild_recorder to current_user;

-- Owning the schema lets the view owner grant USAGE on it to each per-API role.
alter schema lild_api owner to lild_view_owner;

-- Reviewable tables only. The view owner gets nothing on supplier_costs or custodial tables.
grant usage on schema public to lild_view_owner, lild_recorder;
grant select on public.products, public.product_variants, public.product_measurements, public.inventory
  to lild_view_owner;
create policy lild_view_owner_read on public.products for select to lild_view_owner using (true);
create policy lild_view_owner_read on public.product_variants for select to lild_view_owner using (true);
create policy lild_view_owner_read on public.product_measurements for select to lild_view_owner using (true);
create policy lild_view_owner_read on public.inventory for select to lild_view_owner using (true);

grant usage on schema lild to lild_provisioner, lild_recorder;
grant select, insert, delete on lild.grants to lild_provisioner;
create policy lild_provisioner_all on lild.grants for all to lild_provisioner using (true) with check (true);

grant select on public.data_classifications to lild_recorder;
create policy lild_recorder_read on public.data_classifications for select to lild_recorder using (true);

grant select on lild.categories to lild_recorder;
grant select, insert, update on lild.requests, lild.apis to lild_recorder;
grant select, insert on lild.interactions to lild_recorder;
create policy lild_recorder_read on lild.categories for select to lild_recorder using (true);
create policy lild_recorder_all on lild.requests for all to lild_recorder using (true) with check (true);
create policy lild_recorder_all on lild.apis for all to lild_recorder using (true) with check (true);
create policy lild_recorder_add on lild.interactions for insert to lild_recorder with check (true);
create policy lild_recorder_read on lild.interactions for select to lild_recorder using (true);

insert into lild.categories (merchant_id, name)
select id, category from public.merchants cross join (values ('product_discovery'), ('cart_access')) as c (category);
