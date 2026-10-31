-- The agent accesses scoped database views directly, not these RPC endpoints.
revoke execute on function public.lild_plugin_planning_fields() from authenticated;
revoke execute on function public.lild_plugin_read_products(uuid) from authenticated;
