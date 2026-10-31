import assert from "node:assert/strict";
import { test } from "node:test";
import { createMerchantDataPlugin } from "../lib/agent/merchant-data-plugin.ts";

const plugin = createMerchantDataPlugin("merchant-a", [
  { merchantId: "merchant-a", resource: "products", fieldName: "name", category: "reviewable" },
  { merchantId: "merchant-a", resource: "products", fieldName: "price", category: "public" },
  { merchantId: "merchant-a", resource: "products", fieldName: "length", category: "reviewable" },
  { merchantId: "merchant-a", resource: "products", fieldName: "supplier_cost", category: "private" },
  { merchantId: "merchant-a", resource: "carts", fieldName: "items", category: "custodial" },
  { merchantId: "merchant-b", resource: "products", fieldName: "other_field", category: "reviewable" },
]);

test("planner sees only this merchant's public and reviewable fields", () => {
  assert.deepEqual(plugin.planningFields(), [{ resource: "products", fields: ["length", "name", "price"] }]);
  plugin.planningFields()[0].fields.push("supplier_cost");
  assert.deepEqual(plugin.planningFields(), [{ resource: "products", fields: ["length", "name", "price"] }]);
});

test("draft validation checks output and filter fields and denies unknown or private data", () => {
  assert.equal(plugin.validateDraft({ resource: "products", outputFields: ["name"], filterFields: ["length"] }), true);
  assert.equal(plugin.validateDraft({ resource: "products", outputFields: ["supplier_cost"], filterFields: [] }), false);
  assert.equal(plugin.validateDraft({ resource: "products", outputFields: ["name"], filterFields: ["supplier_cost"] }), false);
  assert.equal(plugin.validateDraft({ resource: "products", outputFields: ["other_field"], filterFields: [] }), false);
  assert.equal(plugin.validateDraft({ resource: "carts", outputFields: ["items"], filterFields: [] }), false);
  assert.equal(plugin.validateDraft({ resource: "products", outputFields: [], filterFields: [] }), false);
});
