#!/usr/bin/env node
// Import products from Amazon search-result pages saved in your browser
// (File > Save Page As > "Webpage, HTML Only") into data/products.json.
//
// Usage:
//   node scripts/import-saved-search.mjs --limit 50 saved/*.html
//   node scripts/import-saved-search.mjs --limit 50 --dry-run saved/*.html
//
// Records already in products.json (same ASIN) are skipped. Main images are
// copied into public/assets/<ASIN>-main.jpg. Afterwards run
// `node scripts/build-seed.mjs` so supabase/seed.sql matches the catalog.

import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataFile = path.join(root, 'data', 'products.json');

const args = process.argv.slice(2);
let limit = 50;
let dryRun = false;
const files = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--limit') limit = Number(args[++i]);
  else if (args[i] === '--dry-run') dryRun = true;
  else files.push(args[i]);
}
if (!files.length) {
  console.error('Usage: node scripts/import-saved-search.mjs [--limit N] [--dry-run] page1.html [page2.html ...]');
  process.exit(1);
}

const decode = (s) => s
  .replace(/<[^>]*>/g, '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

const COLORS = ['Black', 'White', 'Grey', 'Gray', 'Navy', 'Blue', 'Green', 'Olive', 'Burgundy', 'Red', 'Pink', 'Beige', 'Khaki', 'Brown', 'Purple', 'Yellow', 'Orange', 'Cream'];
const FABRICS = [/(\d+%\s*[a-z ]*cotton)/i, /(organic cotton)/i, /(denim)/i, /(fleece)/i, /(linen)/i, /(polyester)/i, /(wool)/i, /(cashmere)/i, /(leather)/i, /(cotton blend)/i, /(cotton)/i];
const FITS = [/(slim fit)/i, /(regular fit)/i, /(relaxed fit)/i, /(athletic fit)/i, /(loose fit)/i, /(oversized)/i, /(straight fit)/i, /(skinny)/i];
const CATEGORIES = ['hoodie', 'sweatshirt', 'jacket', 'coat', 'jeans', 'pants', 'shorts', 'dress', 'skirt', 'sweater', 'cardigan', 'polo', 'shirt', 't-shirt', 'tee', 'leggings', 'joggers', 'sneakers', 'shoes', 'boots', 'socks', 'hat', 'beanie'];

function firstMatch(title, patterns, fallback) {
  for (const re of patterns) {
    const m = title.match(re);
    if (m) return m[1].replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return fallback;
}

function sizesFor(title) {
  const t = title.toLowerCase();
  if (/(shoe|sneaker|boot)/.test(t)) return { sizes: ['7', '8', '9', '10', '11', '12'], defaultSize: '9' };
  if (/(jeans|pants|trouser)/.test(t)) return { sizes: ['30W x 30L', '32W x 32L', '34W x 32L', '36W x 32L'], defaultSize: '32W x 32L' };
  if (/(hat|beanie|cap)/.test(t)) return { sizes: ['One Size'], defaultSize: 'One Size' };
  return { sizes: ['S', 'M', 'L', 'XL', 'XXL'], defaultSize: 'M' };
}

function parseCard(block, asin) {
  const ariaTitle = block.match(/<h2[^>]*aria-label="([^"]+)"/);
  const h2s = [...block.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => decode(m[1])).filter(Boolean);
  const title = decode(ariaTitle?.[1] ?? h2s.at(-1) ?? '').replace(/^Sponsored Ad - /, '');
  if (!title) return null;
  // Fashion results show brand as a separate small h2 above the title.
  // No separate brand line means the listing has no brand we can trust.
  let brand = h2s.length > 1 && h2s[0].length <= 40 && h2s[0] !== title ? h2s[0] : 'Amazombie Finds';

  const img = block.match(/<img[^>]*class="[^"]*s-image[^"]*"[^>]*>/)?.[0] ?? '';
  const srcset = img.match(/srcset="([^"]+)"/)?.[1];
  const src = (srcset ? srcset.split(',').map((s) => s.trim().split(' ')[0]).at(-1) : null) ?? img.match(/src="([^"]+)"/)?.[1];

  const priceText = block.match(/<span class="a-offscreen">\$([\d,]+\.\d{2})<\/span>/)?.[1];
  const rating = Number(block.match(/([\d.]+) out of 5 stars/)?.[1]) || null;
  const reviewCount = block.match(/aria-label="([\d,]+) ratings?"/)?.[1]
    ?? (decode(block.match(/<span class="a-size-base s-underline-text">([\d,.K+]+)<\/span>/)?.[1] ?? '') || null);
  const badge = /Best Seller/.test(block) ? '#1 Best Seller' : (/Amazon's Choice|Overall Pick/.test(block) ? "Amazombie's Choice" : null);

  const color = COLORS.find((c) => new RegExp(`\\b${c}\\b`, 'i').test(title)) ?? 'As pictured';
  const category = CATEGORIES.find((c) => title.toLowerCase().includes(c)) ?? 'clothing';
  const fabric = firstMatch(title, FABRICS, 'See original listing');
  const fit = firstMatch(title, FITS, 'Regular fit');
  const shortName = `${brand} ${category.replace(/\b\w/g, (c) => c.toUpperCase())}${color !== 'As pictured' ? ` (${color})` : ''}`;
  const priceUsd = priceText ? Number(priceText.replace(/,/g, '')) : Number((12 + (parseInt(asin.slice(-3), 36) % 40) + 0.99).toFixed(2));

  return {
    asin,
    brand: brand.replace(/^Amazon( Essentials)?$/, "Amazombie$1"),
    name: (title.toLowerCase().includes(brand.toLowerCase()) ? title : `${brand} ${title}`)
      .replace(/Amazon Essentials/gi, 'Amazombie Essentials'),
    shortName: shortName.replace(/Amazon Essentials/gi, 'Amazombie Essentials'),
    color,
    packSize: Number(title.match(/(\d+)[- ]pack/i)?.[1]) || null,
    fabric,
    fit,
    weight: null,
    ...sizesFor(title),
    priceUsd,
    priceBasis: priceText ? 'Price shown in search results when captured; not a live offer' : 'Sample US dollar price; not a live offer',
    rating,
    reviewCount,
    badge,
    category,
    image: `assets/${asin}-main.jpg`,
    imageSourceUrl: src,
    sourceUrl: `https://www.amazon.com/dp/${asin}`,
    highlights: [
      `${category.replace(/\b\w/g, (c) => c.toUpperCase())} in the Amazombie catalog`,
      fabric !== 'See original listing' ? fabric : 'Main product image shown as listed',
      'See original listing for variant, care, and availability details'
    ]
  };
}

const db = JSON.parse(await readFile(dataFile, 'utf8'));
const seen = new Set(db.products.map((p) => p.asin));
const added = [];

for (const file of files) {
  const html = await readFile(file, 'utf8');
  const starts = [...html.matchAll(/<div[^>]*data-asin="([A-Z0-9]{10})"[^>]*data-component-type="s-search-result"|<div[^>]*data-component-type="s-search-result"[^>]*data-asin="([A-Z0-9]{10})"/g)];
  if (!starts.length) console.warn(`${file}: no search-result cards found (bot check page, or not a search page?)`);
  for (let i = 0; i < starts.length && added.length < limit; i += 1) {
    const asin = starts[i][1] ?? starts[i][2];
    if (seen.has(asin)) continue;
    const block = html.slice(starts[i].index, starts[i + 1]?.index ?? starts[i].index + 40000);
    const product = parseCard(block, asin);
    if (!product?.imageSourceUrl) continue;
    // "Save Page As > Complete" rewrites image src to a local *_files/ folder.
    if (!/^https?:/.test(product.imageSourceUrl)) {
      const local = path.resolve(path.dirname(file), decodeURIComponent(product.imageSourceUrl));
      const id = path.basename(local).split('.')[0];
      product.imageLocalPath = existsSync(local) ? local : null;
      product.imageSourceUrl = `https://m.media-amazon.com/images/I/${id}._AC_UL960_.jpg`;
    }
    seen.add(asin);
    added.push(product);
  }
}

console.log(`Parsed ${added.length} new products (limit ${limit}).`);
if (dryRun) {
  for (const p of added) console.log(`${p.asin}  $${p.priceUsd}  ${p.brand} | ${p.name.slice(0, 70)}`);
  process.exit(0);
}

let ok = 0;
for (const p of added) {
  const out = path.join(root, 'public', p.image);
  if (!existsSync(out)) {
    try {
      if (p.imageLocalPath) {
        await copyFile(p.imageLocalPath, out);
      } else {
        const res = await fetch(p.imageSourceUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await writeFile(out, Buffer.from(await res.arrayBuffer()));
        await new Promise((r) => setTimeout(r, 250));
      }
    } catch (err) {
      console.warn(`${p.asin}: image download failed (${err.message}); keeping remote URL`);
      p.image = p.imageSourceUrl;
    }
  }
  delete p.imageSourceUrl;
  delete p.imageLocalPath;
  ok += 1;
}

db.products.push(...added);
await writeFile(dataFile, `${JSON.stringify(db, null, 2)}\n`);
console.log(`Added ${ok} products. Catalog now has ${db.products.length}.`);
