\set ON_ERROR_STOP on
-- Local test fixture: one explicitly approved product, three columns.
create role lild_test_view_owner nologin nobypassrls;
grant usage on schema public, lild_shadow to lild_test_view_owner;
grant create on schema lild_shadow to lild_test_view_owner;
grant select (merchant_id, asin, brand, name) on public.products to lild_test_view_owner;
grant select (merchant_id, resource, field_name, category) on public.data_classifications to lild_test_view_owner;
create policy lild_test_classifications on public.data_classifications for select to lild_test_view_owner
  using (category = 'reviewable');
-- The view owner is still subject to RLS. Reclassification immediately
-- suppresses all rows from this fixed view, including fields used in filters.
create policy lild_test_view on public.products for select to lild_test_view_owner using (
  (select count(*) from public.data_classifications c
   where c.merchant_id = products.merchant_id and c.resource = 'products'
     and c.field_name in ('merchant_id', 'asin', 'brand', 'name') and c.category = 'reviewable') = 4
);
create view lild_shadow.test_approved_products with (security_barrier = true) as
  select asin, brand, name from public.products where asin = 'B0DK3XH9HH';
alter view lild_shadow.test_approved_products owner to lild_test_view_owner;
revoke create on schema lild_shadow from lild_test_view_owner;
grant select on lild_shadow.test_approved_products to lild_shadow_agent;
