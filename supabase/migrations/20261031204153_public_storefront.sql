-- Shopper-visible product fields are public; private and custodial fields remain denied.
alter table public.data_classifications drop constraint data_classifications_category_check;
alter table public.data_classifications add constraint data_classifications_category_check
  check (category in ('public', 'private', 'custodial', 'reviewable'));

update public.data_classifications c set category = 'public'
from public.merchants m
where c.merchant_id = m.id and m.slug = 'amazombie' and (
  (c.resource = 'merchants' and c.field_name in ('id', 'slug')) or
  (c.resource = 'products' and c.field_name in (
    'id', 'merchant_id', 'asin', 'brand', 'name', 'short_name', 'color', 'pack_size',
    'fabric', 'fit', 'weight', 'default_size', 'sample_price_usd', 'price_basis',
    'rating', 'review_count', 'badge', 'image_path', 'source_url', 'highlights'
  )) or
  (c.resource = 'product_variants' and c.field_name in ('merchant_id', 'product_id', 'size'))
);

-- The anonymous storefront and the agent get only these columns. RLS limits
-- rows to the demo merchant and denies the catalog when a field is not public.
grant select (id, slug) on public.merchants to anon, authenticated, lild_shadow_agent;
grant select (resource, field_name) on public.data_classifications to anon, authenticated, lild_shadow_agent;
grant select (id, merchant_id, asin, brand, name, short_name, color, pack_size,
  fabric, fit, weight, default_size, sample_price_usd, price_basis, rating,
  review_count, badge, image_path, source_url, highlights)
  on public.products to anon, authenticated, lild_shadow_agent;
grant select (merchant_id, product_id, size)
  on public.product_variants to anon, authenticated, lild_shadow_agent;

create policy storefront_merchant on public.merchants for select
  to anon, authenticated, lild_shadow_agent using (slug = 'amazombie');
create policy storefront_public_fields on public.data_classifications for select
  to anon, authenticated, lild_shadow_agent
  using (category = 'public' and merchant_id in (select id from public.merchants where slug = 'amazombie'));
create policy storefront_products on public.products for select
  to anon, authenticated, lild_shadow_agent
  using (
    merchant_id in (select id from public.merchants where slug = 'amazombie')
    and (select count(*) from public.data_classifications
      where resource = 'products' and field_name = any (array[
        'id', 'merchant_id', 'asin', 'brand', 'name', 'short_name', 'color', 'pack_size',
        'fabric', 'fit', 'weight', 'default_size', 'sample_price_usd', 'price_basis',
        'rating', 'review_count', 'badge', 'image_path', 'source_url', 'highlights'
      ])) = 20
  );
create policy storefront_variants on public.product_variants for select
  to anon, authenticated, lild_shadow_agent
  using (
    merchant_id in (select id from public.merchants where slug = 'amazombie')
    and (select count(*) from public.data_classifications
      where resource = 'product_variants' and field_name = any (array['merchant_id', 'product_id', 'size'])) = 3
  );

-- Security invoker makes the view obey the caller's grants and RLS policies.
create view public.storefront_catalog with (security_invoker = true) as
select p.asin, p.brand, p.name, p.short_name as "shortName", p.color,
  p.pack_size as "packSize", p.fabric, p.fit, p.weight, p.default_size as "defaultSize",
  p.sample_price_usd as "priceUsd", p.price_basis as "priceBasis", p.rating,
  p.review_count as "reviewCount", p.badge, p.image_path as image,
  p.source_url as "sourceUrl", p.highlights,
  array(select v.size from public.product_variants v
    where v.merchant_id = p.merchant_id and v.product_id = p.id
    order by case v.size when 'S' then 1 when 'M' then 2 when 'L' then 3
      when 'XL' then 4 when 'XXL' then 5 when '3XL' then 6 else 7 end, v.size) as sizes
from public.products p;
revoke all on public.storefront_catalog from public;
grant select on public.storefront_catalog to anon, authenticated, lild_shadow_agent;

-- The planning interface can name both public and reviewable fields; private
-- and custodial metadata remains inaccessible.
alter policy lild_shadow_metadata on public.data_classifications
  using (category in ('public', 'reviewable') and merchant_id in
    (select id from public.merchants where slug = 'amazombie'));
create or replace view lild_shadow.available_fields with (security_barrier = true) as
  select c.resource, c.field_name
  from public.data_classifications c join public.merchants m on m.id = c.merchant_id
  where m.slug = 'amazombie' and c.category in ('public', 'reviewable');
