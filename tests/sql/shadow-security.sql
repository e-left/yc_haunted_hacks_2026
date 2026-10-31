\set ON_ERROR_STOP on

do $$
declare denied boolean;
begin
  if current_user <> 'lild_shadow_agent' then raise exception 'test must run as the agent login'; end if;
  if pg_has_role(current_user, 'lild_shadow_metadata_owner', 'member') then
    raise exception 'agent can assume the metadata owner role';
  end if;
  if not exists (select 1 from lild_shadow.available_fields where resource = 'products' and field_name = 'name') then
    raise exception 'reviewable field metadata unavailable';
  end if;
  if exists (select 1 from lild_shadow.available_fields where resource in ('supplier_costs', 'customer_profiles', 'carts', 'cart_items')) then
    raise exception 'private or custodial metadata exposed';
  end if;
  if (select count(*) from lild_shadow.test_approved_products) <> 1 then
    raise exception 'approved view did not restrict the product rows';
  end if;
  if (select asin from lild_shadow.test_approved_products) <> 'B0DK3XH9HH' then
    raise exception 'approved view returned the wrong product';
  end if;
  denied := false;
  begin perform name from public.products limit 1; exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'unapproved product read succeeded'; end if;
  denied := false;
  begin perform variant_id from public.supplier_costs where unit_cost_usd > 0; exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'private cost filter succeeded'; end if;
  denied := false;
  begin perform p.asin from lild_shadow.test_approved_products p join public.supplier_costs c on c.unit_cost_usd > 0; exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'private data joined through the view'; end if;
  denied := false;
  begin perform * from public.data_classifications; exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'direct classification access succeeded'; end if;
  denied := false;
  begin update public.data_classifications set category = 'reviewable'; exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'agent changed classifications'; end if;
end;
$$;
