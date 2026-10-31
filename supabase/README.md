# Supabase

`config.toml` identifies the local project; the Supabase CLI uses defaults for unspecified settings. Run `supabase start` from the repository root with a Docker-compatible daemon running. Put versioned database migrations in `migrations/`.

No schema, roles, seed data, policies, or hosted project connection have been configured. See [architecture](../docs/architecture.md) before adding data access; privileged Supabase credentials belong on the server and in local environment variables, never in source control.
