# Amazombie demo storefront

This static storefront opens on a T-shirt results grid with Amazombie branding and the user-supplied logo. Shoppers can search, filter by captured color text or sample sizes, sort results, and open a product detail page. Its catalog contains the four ASINs supplied by the user plus 20 more T-shirts indexed from marketplace search results. Product names in the demo use Amazombie branding; the source URLs remain intact for provenance.

| ASIN | Listing |
| --- | --- |
| `B0DK3XH9HH` | [FM London white 3-pack](https://www.amazon.de/dp/B0DK3XH9HH) |
| `B09TPJXFH8` | [Amazombie Essentials black 2-pack](https://www.amazon.de/dp/B09TPJXFH8) |
| `B07RYSG814` | [JACK & JONES organic basic tee](https://www.amazon.de/dp/B07RYSG814) |
| `B0D37QFR64` | [FM London mixed 5-pack](https://www.amazon.de/dp/B0D37QFR64) |

## Run locally

From this directory:

```sh
python3 -m http.server 4173
```

Open `http://localhost:4173/` in a browser. No package install or build step is needed.

## Data provenance and limits

- The four original product images were retrieved on October 31, 2026 from the public product image endpoint using the supplied ASINs: `https://images-na.ssl-images-amazon.com/images/P/<ASIN>.01.L.jpg`.
- The 20 additional ASINs, brands, listing titles, and images came from [marketplace search results for plain men's T-shirts](https://www.amazon.com/s?k=mens+plain+t-shirt) on October 31, 2026. Each record links to its original product page.
- All displayed dollar prices and size selections are **sample demo values**, not live prices or verified stock. Additional listings without a captured price link to their source page for pricing.
- The FM London white 3-pack's 4.4 rating, 14,646 reviews, color and XL selection were captured from the screenshot supplied with the request. The mixed FM London 5-pack title is normalized from the linked product family and its image; its precise fabric composition was not independently verified.
- No product record contains a textual garment length or size-guide measurement. Source listings may show measurements in images. The demo does not transcribe those measurements or invent answers about length.
- “Ask Amazombie” is a deterministic local UI demo over these 24 records. Agent Relay, Terse, Supabase, customer authentication, security review and checkout are not connected here.

The seed data is in [`data/products.json`](data/products.json). The product detail links lead to the original listings for verification.
