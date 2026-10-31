\set ON_ERROR_STOP on

-- All role changes and test data are rolled back at the end.
begin;
grant lild_shadow_agent to postgres;

insert into public.merchants (slug, name) values ('catalog-test-other-merchant', 'Other merchant');
insert into public.products (merchant_id, asin, brand, name, short_name, color, fabric, fit, default_size, price_basis, image_path, source_url)
select m.id, 'OTHER-MERCHANT-TEST', 'Test', 'Other product', 'Other product', 'Blue', 'Cotton', 'Regular', 'M', 'Sample', 'test.jpg', 'https://example.invalid'
from public.merchants m where m.slug = 'catalog-test-other-merchant';
insert into public.data_classifications (merchant_id, resource, field_name, category)
select other.id, c.resource, c.field_name, c.category
from public.merchants other, public.merchants demo, public.data_classifications c
where other.slug = 'catalog-test-other-merchant' and demo.slug = 'amazombie'
  and c.merchant_id = demo.id and c.category = 'public';

set local role anon;
do $$
declare denied boolean;
begin
  if (select count(*) from public.storefront_catalog) = 0 then
    raise exception 'anonymous storefront catalog is empty';
  end if;
  if not exists (select 1 from public.storefront_catalog where "priceUsd" is not null) then
    raise exception 'shopper prices are unavailable';
  end if;
  if exists (select 1 from public.storefront_catalog where asin = 'OTHER-MERCHANT-TEST') then
    raise exception 'another merchant catalog was exposed';
  end if;
  denied := false;
  begin perform unit_cost_usd from public.supplier_costs; exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'supplier cost exposed to shoppers'; end if;
  denied := false;
  begin perform * from public.carts; exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'carts exposed to shoppers'; end if;
  denied := false;
  begin perform created_at from public.products; exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'unpublished product field exposed'; end if;
end;
$$;
reset role;

set local role lild_shadow_agent;
do $$
declare denied boolean;
begin
  if (select count(*) from public.storefront_catalog) = 0 then
    raise exception 'agent cannot read the public storefront catalog';
  end if;
  if not exists (select 1 from lild_shadow.available_fields where resource = 'products' and field_name = 'sample_price_usd') then
    raise exception 'agent cannot plan against shopper prices';
  end if;
  denied := false;
  begin perform unit_cost_usd from public.supplier_costs; exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'supplier cost exposed to agent'; end if;
  denied := false;
  begin perform * from public.carts; exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'carts exposed to agent'; end if;
end;
$$;
reset role;

-- Reclassifying any exposed field must immediately remove the public catalog.
update public.data_classifications set category = 'private'
where resource = 'products' and field_name = 'sample_price_usd'
  and merchant_id in (select id from public.merchants where slug = 'amazombie');
set local role anon;
do $$
begin
  if exists (select 1 from public.storefront_catalog) then
    raise exception 'catalog still exposes a newly private field';
  end if;
  if public.amazombie_catalog() <> '[]'::jsonb then
    raise exception 'legacy catalog RPC still exposes a newly private field';
  end if;
  begin
    perform public.amazombie_place_demo_order('[{"asin":"B0DK3XH9HH","size":"XL","quantity":1}]'::jsonb);
    raise exception 'checkout revealed a newly private shopper price';
  exception when invalid_parameter_value then null;
  end;
end;
$$;
reset role;
rollback;
