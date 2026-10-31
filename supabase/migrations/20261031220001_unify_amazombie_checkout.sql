begin;

-- Keep the legacy RPC used by the deployed static demo on the same public view
-- as the Next.js storefront and merchant dashboard.
create or replace function public.amazombie_catalog()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(c) order by c."shortName"), '[]'::jsonb)
  from public.storefront_catalog c;
$$;
revoke all on function public.amazombie_catalog() from public, anon, authenticated;
grant execute on function public.amazombie_catalog() to anon, authenticated;

-- The order RPC calculates prices with elevated privileges. Reject items as
-- soon as any field needed by the public catalog becomes private.
create function amazombie_private.require_public_order_product()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  product_merchant_id uuid;
begin
  select product.merchant_id into product_merchant_id
  from public.product_variants variant
  join public.products product on product.id = variant.product_id
    and product.merchant_id = variant.merchant_id
  join public.merchants merchant on merchant.id = product.merchant_id
  where variant.id = new.variant_id
    and variant.size = new.size
    and product.asin = new.asin
    and merchant.slug = 'amazombie';

  if product_merchant_id is null
     or (select count(*) from public.data_classifications
         where merchant_id = product_merchant_id and resource = 'products'
           and category = 'public' and field_name = any (array[
             'id', 'merchant_id', 'asin', 'brand', 'name', 'short_name', 'color',
             'pack_size', 'fabric', 'fit', 'weight', 'default_size',
             'sample_price_usd', 'price_basis', 'rating', 'review_count',
             'badge', 'image_path', 'source_url', 'highlights'
           ])) <> 20
     or (select count(*) from public.data_classifications
         where merchant_id = product_merchant_id and resource = 'product_variants'
           and category = 'public'
           and field_name = any (array['merchant_id', 'product_id', 'size'])) <> 3 then
    raise exception 'Product or size is unavailable' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function amazombie_private.require_public_order_product() from public, anon, authenticated;
create trigger require_public_order_product
  before insert on amazombie_private.order_items
  for each row execute function amazombie_private.require_public_order_product();

commit;
