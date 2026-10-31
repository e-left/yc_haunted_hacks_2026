#!/usr/bin/env node
// Rewrite the catalog JSON embedded in supabase/seed.sql from data/products.json.
// data/products.json is the source of truth; run this after editing it, then
// `./dev supabase db reset` to reload the local database.
//
//   node scripts/build-seed.mjs          # update supabase/seed.sql
//   node scripts/build-seed.mjs --check  # exit 1 if seed.sql is out of date

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const seedFile = path.join(root, "supabase", "seed.sql");
const { products } = JSON.parse(await readFile(path.join(root, "data", "products.json"), "utf8"));

const json = JSON.stringify(products);
if (json.includes("$catalog$")) throw new Error("Catalog text contains the $catalog$ quote tag.");

const seed = await readFile(seedFile, "utf8");
const block = /\$catalog\$\[[\s\S]*?\]\$catalog\$/g;
const count = seed.match(block)?.length ?? 0;
if (count === 0) throw new Error("No $catalog$[...]$catalog$ block found in supabase/seed.sql.");

const next = seed.replace(block, () => `$catalog$${json}$catalog$`);
if (process.argv.includes("--check")) {
  if (next !== seed) {
    console.error("supabase/seed.sql is out of date; run node scripts/build-seed.mjs");
    process.exit(1);
  }
  console.log(`supabase/seed.sql matches data/products.json (${products.length} products).`);
} else {
  await writeFile(seedFile, next);
  console.log(`Wrote ${products.length} products into ${count} catalog blocks in supabase/seed.sql.`);
}
