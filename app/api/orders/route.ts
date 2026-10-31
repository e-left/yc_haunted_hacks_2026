type OrderItem = { asin: string; size: string; quantity: number };

function validItems(value: unknown): value is OrderItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return false;
  const seen = new Set<string>();
  return value.every((item) => {
    if (!item || typeof item !== "object") return false;
    const { asin, size, quantity } = item as Partial<OrderItem>;
    if (typeof asin !== "string" || !/^[A-Z0-9]{10}$/.test(asin) ||
        typeof size !== "string" || !/^[A-Z0-9]{1,4}$/.test(size) ||
        typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) return false;
    const key = `${asin}:${size}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const items = body && typeof body === "object" && "items" in body ? body.items : undefined;
  if (!validItems(items)) {
    return Response.json({ error: "Provide 1 to 20 valid basket lines." }, { status: 400 });
  }

  const baseUrl = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!baseUrl || !publishableKey) {
    return Response.json({ error: "Checkout is unavailable." }, { status: 503 });
  }

  try {
    const url = new URL("/rest/v1/rpc/amazombie_place_demo_order", baseUrl);
    const response = await fetch(url, {
      method: "POST",
      headers: { apikey: publishableKey, "Content-Type": "application/json" },
      body: JSON.stringify({ p_items: items }),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return Response.json({ error: response.status < 500 ? "A product or size is unavailable." : "Checkout is unavailable." },
        { status: response.status < 500 ? 400 : 503 });
    }
    const order: unknown = await response.json();
    if (!order || typeof order !== "object" || !("id" in order) || !("totalCents" in order) ||
        typeof order.id !== "string" || !Number.isInteger(order.totalCents)) {
      throw new Error("Invalid order confirmation");
    }
    return Response.json(order);
  } catch {
    return Response.json({ error: "Checkout is unavailable." }, { status: 503 });
  }
}
