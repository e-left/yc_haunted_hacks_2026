#!/usr/bin/env bash
set -euo pipefail
project_root=$(cd "$(dirname "$0")/.." && pwd)

# Replay the schema and seed in a disposable, network-isolated database.
docker run --rm --network none \
  --mount "type=bind,src=$project_root/supabase/migrations/20261031200213_create_merchant_catalog.sql,dst=/check/catalog.sql,readonly" \
  --mount "type=bind,src=$project_root/supabase/migrations/20261031202909_create_shadow_agent.sql,dst=/check/shadow.sql,readonly" \
  --mount "type=bind,src=$project_root/supabase/migrations/20261031204153_public_storefront.sql,dst=/check/public.sql,readonly" \
  --mount "type=bind,src=$project_root/supabase/migrations/20261031220000_amazombie_demo_checkout.sql,dst=/check/checkout.sql,readonly" \
  --mount "type=bind,src=$project_root/supabase/migrations/20261031220001_unify_amazombie_checkout.sql,dst=/check/unify.sql,readonly" \
  --mount "type=bind,src=$project_root/supabase/seed.sql,dst=/check/seed.sql,readonly" \
  --mount "type=bind,src=$project_root/tests/sql/public-catalog.sql,dst=/check/security.sql,readonly" \
  --mount "type=bind,src=$project_root/tests/sql/demo-checkout.sql,dst=/check/demo-checkout.sql,readonly" \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine sh -eu -c '
    docker-entrypoint.sh postgres > /tmp/postgres.log 2>&1 &
    for i in $(seq 1 200); do
      if grep -q "PostgreSQL init process complete" /tmp/postgres.log && pg_isready -U postgres -q; then break; fi
      sleep 0.1
    done
    pg_isready -U postgres -q
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "create role anon; create role authenticated; create schema auth; create table auth.users (id uuid primary key);"
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f /check/catalog.sql
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f /check/shadow.sql
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f /check/public.sql
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f /check/checkout.sql
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f /check/unify.sql
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f /check/seed.sql
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f /check/security.sql
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f /check/demo-checkout.sql
  '
