-- SYNTHETIC demo data, not real measurements, stock or costs. Safe to rerun.
-- Remove with:
--   delete from public.product_measurements where source = 'demo seed';
-- and truncate inventory and supplier_costs if they hold nothing else.

insert into public.product_measurements (merchant_id, variant_id, body_length_inches, source)
select v.merchant_id, v.id,
  case v.size when 'S' then 27 when 'M' then 28 when 'L' then 29 when 'XL' then 30 when 'XXL' then 31 else 32 end
    + (abs(hashtext(v.product_id::text)) % 3 - 1) * 0.5,
  'demo seed'
from public.product_variants v
on conflict do nothing;

insert into public.inventory (merchant_id, variant_id, quantity)
select v.merchant_id, v.id,
  case when abs(hashtext(v.id::text)) % 5 = 0 then 0 else 1 + abs(hashtext(v.id::text)) % 40 end
from public.product_variants v
on conflict do nothing;

insert into public.supplier_costs (merchant_id, variant_id, unit_cost_usd)
select v.merchant_id, v.id, round(coalesce(p.sample_price_usd, 20) * 0.35, 2)
from public.product_variants v
join public.products p on p.merchant_id = v.merchant_id and p.id = v.product_id
on conflict do nothing;
