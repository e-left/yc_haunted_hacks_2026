-- Remove the unused RPC approach only if it has never held any data.
do $$
begin
  if exists (select 1 from public.lild_plugin_accounts)
     or exists (select 1 from public.lild_plugin_approvals)
     or exists (select 1 from public.lild_plugin_invocations) then
    raise exception 'Agent RPC tables are not empty; refusing to remove them';
  end if;
end;
$$;

drop function public.lild_plugin_planning_fields();
drop function public.lild_plugin_read_products(uuid);
drop policy lild_plugin_executor_read on public.data_classifications;
drop policy lild_plugin_executor_read on public.products;
drop table public.lild_plugin_invocations;
drop table public.lild_plugin_approvals;
drop table public.lild_plugin_accounts;
revoke select (merchant_id, resource, field_name, category) on public.data_classifications from lild_plugin_executor;
revoke select (id, merchant_id, asin, brand, name) on public.products from lild_plugin_executor;
revoke execute on function auth.uid() from lild_plugin_executor;
revoke usage on schema public, auth from lild_plugin_executor;
drop role lild_plugin_executor;
