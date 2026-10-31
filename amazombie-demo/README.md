# Amazombie demo storefront

This static storefront reproduces the layout of the supplied Amazon product screenshot with Amazombie branding. Its catalog contains **only the four ASINs supplied by the user**:

| ASIN | Listing |
| --- | --- |
| `B0DK3XH9HH` | [FM London white 3-pack](https://www.amazon.de/dp/B0DK3XH9HH) |
| `B09TPJXFH8` | [Amazon Essentials black 2-pack](https://www.amazon.de/dp/B09TPJXFH8) |
| `B07RYSG814` | [JACK & JONES organic basic tee](https://www.amazon.de/dp/B07RYSG814) |
| `B0D37QFR64` | [FM London mixed 5-pack](https://www.amazon.de/dp/B0D37QFR64) |

## Run locally

From this directory:

```sh
python3 -m http.server 4173
```

Open `http://localhost:4173/` in a browser. No package install or build step is needed.

## Data provenance and limits

- The four product images were retrieved on October 31, 2026 from Amazon's public image endpoint using the supplied ASINs: `https://images-na.ssl-images-amazon.com/images/P/<ASIN>.01.L.jpg`. The endpoint supplied one main image per ASIN.
- The default FM London white 3-pack's displayed €15.37 price, 4.4 rating, 14,646 reviews, color and XL selection were captured from the screenshot supplied with the request.
- Other display prices and all size selections are **sample demo values**, not live Amazon prices or verified stock. The mixed FM London 5-pack title is normalized from the linked product family and its image; its precise fabric composition was not independently verified.
- Exact body lengths, live availability and care instructions were not available in the imported data. The UI does not invent answers to those questions.
- “Ask Amazombie” is a deterministic local UI demo over these four records. Agent Relay, Terse, Supabase, customer authentication, security review and checkout are not connected here.

The seed data is in [`data/products.json`](data/products.json). The product detail links lead to the original listings for verification.
