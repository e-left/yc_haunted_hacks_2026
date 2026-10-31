import type { Product } from "./product";

// A deterministic demo response, not an agent or a security decision.
export function answerQuestion(question: string, product: Product, products: readonly Product[]): string {
  const q = question.toLowerCase();
  if (/supplier|wholesale|cost price|private/.test(q)) return "Supplier costs are private and are not part of this customer-facing catalog.";
  if (/length|long|inch|measurement|under 30/.test(q)) return "Body length is not present in the imported listing data. I cannot verify a length limit for these shirts.";
  if (/wash|care|dryer/.test(q)) return "Care instructions were not verified for this selected listing. Please check the original product page before washing.";
  if (/colour|color|black|white/.test(q) && /which|all|catalog/.test(q)) {
    const matches = products.filter((item) => q.includes("black") ? item.color.toLowerCase().includes("black") : q.includes("white") ? item.color.toLowerCase().includes("white") : item.color !== "As pictured");
    return matches.length ? `Among the ${products.length} listed shirts with verified color text: ${matches.map((item) => item.shortName).join("; ")}.` : "No verified color match is in this catalog. Some listings only show color in their images.";
  }
  if (/colour|color/.test(q)) return product.color === "As pictured" ? "The color is shown in the product image but was not captured as text. Check the source listing for the exact variant name." : `The linked variant shown here is ${product.color}.`;
  if (/slim|fit|tailor/.test(q)) return product.fit === "Not verified" ? "Fit was not verified in the imported listing data." : `The listed fit is ${product.fit}. Exact measurements are not available in the imported data.`;
  if (/cotton|fabric|material/.test(q)) return product.fabric === "Not verified" ? "Fabric composition was not verified in the imported listing data." : `Fabric information for this item: ${product.fabric}.`;
  if (/size/.test(q)) return `The demo size selector shows ${product.sizes.join(", ")}. Availability by size is not live.`;
  if (/price|cheap|cost/.test(q)) return product.priceUsd == null ? "A current price was not captured for this listing. Check the source product page." : `The displayed sample price is $${product.priceUsd.toFixed(2)}. ${product.priceBasis}.`;
  if (/pack|how many/.test(q)) return product.packSize == null ? "The pack size was not verified in the imported listing data." : `This listing shows a pack of ${product.packSize}.`;
  return `I can answer from these ${products.length} imported listings about verified color, fabric, fit, and pack details. I cannot verify missing measurements or live availability.`;
}
