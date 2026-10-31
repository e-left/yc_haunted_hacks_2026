\set ON_ERROR_STOP on
begin;
set local role anon;
do $$
declare
  order_result jsonb;
begin
  if jsonb_array_length(public.amazombie_catalog()) <> (select count(*) from public.storefront_catalog) then
    raise exception 'the catalog RPC did not return all seeded products';
  end if;
  order_result := public.amazombie_place_demo_order('[{"asin":"B0DK3XH9HH","size":"XL","quantity":2}]'::jsonb);
  if (order_result->>'totalCents')::integer <> 3398 then
    raise exception 'checkout did not use the database sample price';
  end if;
end;
$$;
reset role;
do $$
begin
  if (select count(*) from amazombie_private.orders) <> 1
     or (select count(*) from amazombie_private.order_items where unit_price_cents = 1699 and quantity = 2) <> 1 then
    raise exception 'demo order was not stored in private tables';
  end if;
end;
$$;
rollback;
