import type { FieldType, MerchantPolicy } from "./contracts/index.js";

export interface CatalogField {
  /** Physical source, used to look up the merchant's classification. */
  table: string;
  column: string;
  type: FieldType;
  /** Null means no view may ever select this field, whatever its classification says. */
  sql: string | null;
}

/** Code-owned. Plans name logical fields; they never supply table paths or joins. */
export const PRODUCTS_FROM = `public.product_variants v
  join public.products p on p.merchant_id = v.merchant_id and p.id = v.product_id
  left join public.product_measurements m on m.merchant_id = v.merchant_id and m.variant_id = v.id
  left join public.inventory i on i.merchant_id = v.merchant_id and i.variant_id = v.id`;

export const PRODUCT_FIELDS: Record<string, CatalogField> = {
  product_id: { table: "products", column: "id", type: "string", sql: "p.id" },
  asin: { table: "products", column: "asin", type: "string", sql: "p.asin" },
  variant_id: { table: "product_variants", column: "id", type: "string", sql: "v.id" },
  size: { table: "product_variants", column: "size", type: "string", sql: "v.size" },
  name: { table: "products", column: "name", type: "string", sql: "p.name" },
  short_name: { table: "products", column: "short_name", type: "string", sql: "p.short_name" },
  brand: { table: "products", column: "brand", type: "string", sql: "p.brand" },
  color: { table: "products", column: "color", type: "string", sql: "p.color" },
  fabric: { table: "products", column: "fabric", type: "string", sql: "p.fabric" },
  fit: { table: "products", column: "fit", type: "string", sql: "p.fit" },
  price_usd: { table: "products", column: "sample_price_usd", type: "number", sql: "p.sample_price_usd" },
  rating: { table: "products", column: "rating", type: "number", sql: "p.rating" },
  body_length_inches: { table: "product_measurements", column: "body_length_inches", type: "number", sql: "m.body_length_inches" },
  quantity: { table: "inventory", column: "quantity", type: "number", sql: "i.quantity" },
  supplier_cost: { table: "supplier_costs", column: "unit_cost_usd", type: "number", sql: null },
};

export interface ClassificationRow {
  resource: string;
  field_name: string;
  category: string;
}

const CUSTODIAL_CATEGORY = "cart_access";

/** Fails closed: a field absent from `data_classifications` is left out, so it is inaccessible. */
export function buildPolicy(merchantId: string, rows: ClassificationRow[]): MerchantPolicy {
  const lookup = new Map(rows.map((row) => [`${row.resource}.${row.field_name}`, row.category]));
  const fields: MerchantPolicy["resources"][string]["fields"] = {};
  for (const [name, field] of Object.entries(PRODUCT_FIELDS)) {
    const category = lookup.get(`${field.table}.${field.column}`);
    if (category === "private" || category === "custodial" || category === "reviewable") {
      fields[name] = { classification: category, type: field.type };
    }
  }
  const resources: MerchantPolicy["resources"] = {
    products: {
      category: "product_discovery",
      identifierFields: ["product_id", "variant_id"],
      description: "T-shirts sold by this merchant, one row per product and size. Every row is a shirt. quantity is units in stock.",
      fields,
    },
  };
  for (const row of rows) {
    if (row.category !== "custodial") continue;
    resources[row.resource] ??= { category: CUSTODIAL_CATEGORY, fields: {} };
    resources[row.resource]!.fields[row.field_name] = { classification: "custodial", type: "string" };
  }
  return { merchantId, maxApiTtlSeconds: 900, maxRowLimit: 100, resources };
}
