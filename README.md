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

## Update the catalog

`data/products.json` is the catalog source; product images live in `public/assets/`. After editing it, regenerate the seed and reload the local database:

```sh
node scripts/build-seed.mjs
./dev supabase db reset
```

To add products from an Amazon search page saved in your browser (File > Save Page As), run `node scripts/import-saved-search.mjs --limit 50 "<saved page>.html"` first. It skips existing ASINs and copies the main images into `public/assets/`. Prices, ratings and review counts come from the search results as captured; sizes are samples.
