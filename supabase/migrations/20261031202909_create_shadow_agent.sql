-- A single direct Postgres login. No password is set by this migration, so it
-- cannot authenticate until an administrator provisions one securely.
create role lild_shadow_agent login noinherit nocreatedb nocreaterole noreplication nobypassrls password null;

-- A non-login owner exposes only reviewable schema metadata for this merchant.
create role lild_shadow_metadata_owner nologin noinherit nocreatedb nocreaterole noreplication nobypassrls;
grant lild_shadow_metadata_owner to current_user;
grant usage on schema public to lild_shadow_metadata_owner;
grant select (id, slug) on public.merchants to lild_shadow_metadata_owner;
grant select (merchant_id, resource, field_name, category) on public.data_classifications to lild_shadow_metadata_owner;

create policy lild_shadow_metadata on public.merchants for select to lild_shadow_metadata_owner
  using (slug = 'amazombie');
create policy lild_shadow_metadata on public.data_classifications for select to lild_shadow_metadata_owner
  using (category = 'reviewable' and merchant_id in (select id from public.merchants where slug = 'amazombie'));

create schema lild_shadow authorization lild_shadow_metadata_owner;
create view lild_shadow.available_fields with (security_barrier = true) as
  select c.resource, c.field_name
  from public.data_classifications c join public.merchants m on m.id = c.merchant_id
  where m.slug = 'amazombie' and c.category = 'reviewable';
alter view lild_shadow.available_fields owner to lild_shadow_metadata_owner;

revoke all on schema lild_shadow from public;
revoke all on lild_shadow.available_fields from public;
grant usage on schema lild_shadow to lild_shadow_agent;
grant select on lild_shadow.available_fields to lild_shadow_agent;
