import type { Product } from "./product";

export async function getProducts(): Promise<Product[]> {
  const baseUrl = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!baseUrl || !publishableKey) throw new Error("Supabase catalog is not configured.");

  const url = new URL("/rest/v1/storefront_catalog", baseUrl);
  url.searchParams.set("select", "*");
  url.searchParams.set("order", "shortName.asc");
  const response = await fetch(url, {
    headers: { apikey: publishableKey },
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Supabase catalog request failed (${response.status}).`);

  const products: unknown = await response.json();
  if (!Array.isArray(products)) throw new Error("Supabase returned an invalid catalog.");
  return products as Product[];
}
