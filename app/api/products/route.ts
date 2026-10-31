import { getProducts } from "../../../lib/catalog";

export async function GET() {
  try {
    return Response.json({ products: await getProducts() });
  } catch {
    return Response.json({ error: "Product catalog is unavailable." }, { status: 503 });
  }
}
