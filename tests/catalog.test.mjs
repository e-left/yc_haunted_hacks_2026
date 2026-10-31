import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { getProducts } from "../lib/catalog.ts";

test("catalog reads fresh Supabase data and surfaces failures", async () => {
  let name = "First name";
  let status = 200;
  const server = createServer((request, response) => {
    assert.equal(request.headers.apikey, "test-publishable-key");
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify([{ asin: "test", name }]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  process.env.SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
  try {
    assert.equal((await getProducts())[0].name, "First name");
    name = "Updated name";
    assert.equal((await getProducts())[0].name, "Updated name");
    status = 503;
    await assert.rejects(getProducts(), /catalog request failed/);
  } finally {
    if (previousUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY; else process.env.SUPABASE_PUBLISHABLE_KEY = previousKey;
    await new Promise((resolve) => server.close(resolve));
  }
});
