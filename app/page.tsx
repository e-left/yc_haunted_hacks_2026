import { getProducts } from "../lib/catalog";
import { Storefront } from "../components/storefront";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ asin?: string; q?: string }> }) {
  const { asin, q } = await searchParams;
  const products = await getProducts();
  return <Storefront products={products} initialAsin={asin} initialSearch={q} />;
}
