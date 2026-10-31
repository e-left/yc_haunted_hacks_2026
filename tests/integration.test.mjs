import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { after, before, test } from "node:test";

let server;
let base;
let output = "";

before(async () => {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--port", String(port)], {
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => { output += chunk; });
  server.stderr.on("data", (chunk) => { output += chunk; });

  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Next.js exited: ${output}`);
    try {
      const response = await fetch(`${base}/api/health/live`);
      if (response.ok) return;
    } catch { /* The server is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Next.js did not start: ${output}`);
});

after(() => { server?.kill("SIGTERM"); });

test("storefront, dashboard, and API share the catalog", async () => {
  const catalog = await (await fetch(`${base}/api/products`)).json();
  assert.ok(catalog.products.length > 0);
  const product = catalog.products.at(-1);

  const home = await (await fetch(base)).text();
  assert.ok(home.includes("T-shirts worth resurrecting"));
  assert.equal((home.match(/class="result-card"/g) ?? []).length, catalog.products.length);

  const search = await (await fetch(`${base}/?q=B07RYSG814`)).text();
  assert.equal((search.match(/class="result-card"/g) ?? []).length, 1);
  assert.ok(search.includes("JACK &amp; JONES"));

  const storefront = await (await fetch(`${base}/?asin=${encodeURIComponent(product.asin)}`)).text();
  assert.ok(storefront.split("<h1>")[1]?.split("</h1>")[0].includes(product.brand));
  assert.ok(storefront.includes(product.asin));

  const dashboard = await (await fetch(`${base}/dashboard`)).text();
  assert.ok(dashboard.includes(product.asin));
  assert.ok(dashboard.includes("Merchant dashboard"));
  assert.equal((await fetch(`${base}/${product.image}`)).status, 200);
  assert.deepEqual(await (await fetch(`${base}/health/live`)).json(), { status: "ok" });
});

test("demo questions are answered by the backend and invalid requests fail", async () => {
  const ask = (body) => fetch(`${base}/api/ask`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await ask({ question: "Which shirts are under 30 inches?", asin: "B0DK3XH9HH" });
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.mode, "demo");
  assert.match(body.answer, /Body length is not present/);
  assert.equal((await ask({ question: "", asin: "B0DK3XH9HH" })).status, 400);
  assert.equal((await ask({ question: "What color?", asin: "unknown" })).status, 404);
});

test("checkout rejects malformed basket lines before calling Supabase", async () => {
  const response = await fetch(`${base}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: [{ asin: "B0DK3XH9HH", size: "XL", quantity: 0 }] }),
  });
  assert.equal(response.status, 400);
});
