-- Per-API login roles do not work through Supavisor: expired logins count as auth failures
-- and trip a circuit breaker for the whole connection. Per-API roles now cannot log in.
-- One stable executor login switches to a per-API role for a single read.
--
-- Known limit: the executor credential can switch to any active API's role. Private and
-- custodial data stay out of reach. The credential lives only on the server side.

create role lild_executor nologin noinherit nobypassrls connection limit 10;
grant lild_executor to current_user;
-- The login and password are set outside this file, so no secret enters version control.
