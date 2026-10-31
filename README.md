# LI/LD

Starter monorepo for the product described in [SPEC.md](SPEC.md). See [product architecture](docs/architecture.md) for boundaries, implementation order, and the security decisions that remain open.

- `apps/web` — React merchant interface
- `apps/api` — Bun/TypeScript API and gateway
- `packages/contracts` — shared API types
- `supabase/migrations` — database schema and policies

## Development

Install Nix with flakes enabled, then enter the development shell and install the workspace dependencies:

```sh
source .envrc
nix develop path:.
bun install
bun run dev
```

The shell provides Bun, the Supabase CLI, and the Docker client. Run `source .envrc` from the repository root to load credentials from the Git-ignored `.env.local` file, then enter the Nix shell. The file is sourced as shell code and should only be writable by trusted users; keep credentials out of tracked files and the Nix store. JavaScript dependencies are installed separately by `bun install`. Vite prints the web URL; the API listens on port 3001 by default. The web development server proxies `/api` to the API. Run `bun run typecheck` and `bun run build` to check the workspace.

For local Supabase, a running Docker-compatible daemon is also required (the Nix shell provides the client, not the daemon). From the repository root run `supabase start` and later `supabase stop`. Alternatively, use a hosted Supabase project; no project is linked by this scaffold. Do not commit credentials or expose privileged keys to the browser.

The only API endpoint is `GET /health/live` (process liveness). No external services or product workflows are connected yet. Freestyle can be considered for agent development environments, but is not connected; the spec calls for Terse actors and prohibits arbitrary generated execution.
