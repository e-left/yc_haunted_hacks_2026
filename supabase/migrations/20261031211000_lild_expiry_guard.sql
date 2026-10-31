-- Supavisor does not reliably enforce a role's VALID UNTIL, so expiry is enforced at read time.
-- Each per-API view calls this guard. It raises rather than filters, so an expired API can
-- never look like a successful empty result.
create function lild.require_unexpired(expires_at timestamptz) returns boolean
  language plpgsql stable
  set search_path = pg_catalog
as $$
begin
  if now() >= expires_at then
    raise exception 'api expired' using errcode = 'P0001';
  end if;
  return true;
end
$$;

revoke all on function lild.require_unexpired(timestamptz) from public;
grant usage on schema lild to lild_view_owner;
grant execute on function lild.require_unexpired(timestamptz) to public;
