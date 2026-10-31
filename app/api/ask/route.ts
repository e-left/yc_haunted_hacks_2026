import { getProducts } from "../../../lib/catalog";
import { answerQuestion } from "../../../lib/demo-answers";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body || typeof body !== "object" || !("question" in body) || !("asin" in body) ||
      typeof body.question !== "string" || typeof body.asin !== "string" ||
      !body.question.trim() || body.question.length > 300) {
    return Response.json({ error: "Provide an ASIN and a question of up to 300 characters." }, { status: 400 });
  }

  try {
    const products = await getProducts();
    const product = products.find((item) => item.asin === body.asin);
    if (!product) return Response.json({ error: "Product not found." }, { status: 404 });
    return Response.json({ answer: answerQuestion(body.question, product, products), mode: "demo" });
  } catch {
    return Response.json({ error: "Product catalog is unavailable." }, { status: 503 });
  }
}
