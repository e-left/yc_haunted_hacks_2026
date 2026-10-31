# Amazombie demo storefront

This storefront opens on a T-shirt results grid with Amazombie branding and the user-supplied logo. Shoppers can search, filter by captured color text or sample sizes, sort results, choose a size and quantity, add products to a basket, and complete a demo checkout. Its catalog contains the four ASINs supplied by the user plus 20 more T-shirts indexed from marketplace search results. Product names in the demo use Amazombie branding; the source URLs remain intact for provenance.

| ASIN | Listing |
| --- | --- |
| `B0DK3XH9HH` | [FM London white 3-pack](https://www.amazon.de/dp/B0DK3XH9HH) |
| `B09TPJXFH8` | [Amazombie Essentials black 2-pack](https://www.amazon.de/dp/B09TPJXFH8) |
| `B07RYSG814` | [JACK & JONES organic basic tee](https://www.amazon.de/dp/B07RYSG814) |
| `B0D37QFR64` | [FM London mixed 5-pack](https://www.amazon.de/dp/B0D37QFR64) |

## Run locally

From this directory:

```sh
cp .env.example .env.local
python3 serve.py --port 4173
```

Open `http://localhost:4173/` in a browser. No package install or build step is needed. With an empty `SUPABASE_PUBLISHABLE_KEY`, checkout remains a browser-only demo.

## Connect Supabase

1. Apply [`../supabase/migrations/20261031000000_amazombie_demo.sql`](../supabase/migrations/20261031000000_amazombie_demo.sql) to project `jhzbfupmolwqdjlgwuss`, for example with `supabase link --project-ref jhzbfupmolwqdjlgwuss` followed by `supabase db push` from the repository root.
2. Copy the project's publishable key into `.env.local` as `SUPABASE_PUBLISHABLE_KEY` (a legacy anon key can be supplied as `SUPABASE_ANON_KEY`). The project URL is already in `.env.example`. The server also reads a root `.env.local` if you already use one.
3. Restart `serve.py`. The storefront then loads its sample prices and sizes from Supabase and saves demo orders with the `amazombie_place_demo_order` RPC. If the connection fails, it shows a notice and uses the local demo catalog and checkout.

The local server exposes only the URL and publishable key to the browser. The SQL function calculates totals from database prices. Delivery fields stay in the browser; the database stores selected items, total and timestamp only. No payment is collected.

## Data provenance and limits

- The four original product images were retrieved on October 31, 2026 from the public product image endpoint using the supplied ASINs: `https://images-na.ssl-images-amazon.com/images/P/<ASIN>.01.L.jpg`.
- The 20 additional ASINs, brands, listing titles, and images came from [marketplace search results for plain men's T-shirts](https://www.amazon.com/s?k=mens+plain+t-shirt) on October 31, 2026. Each record links to its original product page.
- All displayed dollar prices and size selections are **sample demo values**, not live prices or verified stock. Every product has a sample price so the entire catalog can be used in the checkout demo.
- The FM London white 3-pack's 4.4 rating, 14,646 reviews, color and XL selection were captured from the screenshot supplied with the request. The mixed FM London 5-pack title is normalized from the linked product family and its image; its precise fabric composition was not independently verified.
- No product record contains a textual garment length or size-guide measurement. Source listings may show measurements in images. The demo does not transcribe those measurements or invent answers about length.
- The basket is stored in this browser's local storage. Without Supabase configuration, demo orders are also stored there. With Supabase configured, demo orders are stored in Supabase. Delivery form values are not saved or sent. Checkout does not process a payment, reserve stock, or send an order to a merchant.
- “Ask Amazombie” is a deterministic local UI demo over these 24 records. Agent Relay, Terse, customer authentication, and security review are not connected to the storefront.

The seed data is in [`data/products.json`](data/products.json). The product detail links lead to the original listings for verification.
