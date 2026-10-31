\set ON_ERROR_STOP on
do $$
begin
  if exists (select 1 from lild_shadow.available_fields where resource = 'products' and field_name = 'name') then
    raise exception 'newly private field is still visible in the planning view';
  end if;
  if exists (select 1 from lild_shadow.test_approved_products) then
    raise exception 'approved view still reveals a field after reclassification';
  end if;
end;
$$;
