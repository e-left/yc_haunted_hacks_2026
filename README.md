# Amazombie

Demo storefront and dashboard in Next.js, using the same Supabase products. Checkout saves demo orders; no payment is collected. Supplier costs are private. “Ask Amazombie” and the separate agent relay still return demo results.

## Run locally

With Nix and Docker installed, run:

```sh
./dev supabase start
./dev node scripts/configure-local-supabase.mjs
./dev npm run dev
```

Open the [storefront](http://localhost:3000), [dashboard](http://localhost:3000/dashboard), or [Supabase Studio](http://localhost:54323). Run `./dev npm test` to check the app and `./dev bash tests/run-public-catalog-security.sh` to check database access. The separate Rust relay has its own [run instructions](docs/HANDOFF.md). [SPEC.md](SPEC.md) describes the intended system.
