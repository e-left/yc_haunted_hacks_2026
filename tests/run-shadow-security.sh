#!/usr/bin/env bash
set -euo pipefail
project_root=$(cd "$(dirname "$0")/.." && pwd)

# An isolated, disposable Postgres instance with mock Supabase roles. No real
# Supabase credentials or production data are mounted into the container.
docker run --rm --network none \
  --mount "type=bind,src=$project_root/supabase/migrations/20261031200213_create_merchant_catalog.sql,dst=/check/catalog.sql,readonly" \
  --mount "type=bind,src=$project_root/supabase/migrations/20261031202909_create_shadow_agent.sql,dst=/check/shadow.sql,readonly" \
  --mount "type=bind,src=$project_root/tests/sql/shadow-fixture.sql,dst=/check/fixture.sql,readonly" \
  --mount "type=bind,src=$project_root/tests/sql/shadow-view-setup.sql,dst=/check/view.sql,readonly" \
  --mount "type=bind,src=$project_root/tests/sql/shadow-security.sql,dst=/check/security.sql,readonly" \
  --mount "type=bind,src=$project_root/tests/sql/shadow-reclassification.sql,dst=/check/reclassification.sql,readonly" \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine sh -eu -c '
    docker-entrypoint.sh postgres > /tmp/postgres.log 2>&1 &
    for i in $(seq 1 200); do
      if grep -q "PostgreSQL init process complete" /tmp/postgres.log && pg_isready -U postgres -q; then break; fi
      sleep 0.1
    done
    pg_isready -U postgres -q
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "create role anon; create role authenticated; create schema auth; create table auth.users (id uuid primary key);"
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f /check/catalog.sql
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f /check/fixture.sql
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f /check/shadow.sql
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f /check/view.sql
    psql -v ON_ERROR_STOP=1 -U lild_shadow_agent -d postgres -f /check/security.sql
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "update public.data_classifications set category = '\''private'\'' where resource = '\''products'\'' and field_name = '\''name'\'';"
    psql -v ON_ERROR_STOP=1 -U lild_shadow_agent -d postgres -f /check/reclassification.sql
  '
