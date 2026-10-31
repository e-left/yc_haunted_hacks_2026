import { describe, expect, it } from "vitest";
import { buildPolicy } from "../src/catalog.js";
import type { Plan } from "../src/contracts/index.js";
import { exposedInterface, withIdentifiers } from "../src/validate/index.js";

const reviewable = (resource: string, field_name: string) => ({ resource, field_name, category: "reviewable" });

describe("policy from data_classifications", () => {
  it("hides unclassified fields", () => {
    const policy = buildPolicy("m", [reviewable("products", "name")]);
    expect(Object.keys(policy.resources.products!.fields)).toEqual(["name"]);
  });

  it("never exposes private supplier cost", () => {
    const policy = buildPolicy("m", [
      reviewable("products", "name"),
      { resource: "supplier_costs", field_name: "unit_cost_usd", category: "private" },
    ]);
    expect(policy.resources.products!.fields.supplier_cost?.classification).toBe("private");
    expect(JSON.stringify(exposedInterface(policy))).not.toContain("supplier_cost");
  });

  it("keeps custodial resources out of the planning interface", () => {
    const policy = buildPolicy("m", [
      reviewable("products", "name"),
      { resource: "carts", field_name: "user_id", category: "custodial" },
    ]);
    expect(policy.resources.carts!.fields.user_id?.classification).toBe("custodial");
    expect(exposedInterface(policy).map((resource) => resource.name)).toEqual(["products"]);
  });

  const plan: Plan = { version: 1, resource: "products", fields: ["name"], filters: [], limit: 1, inputs: [], purpose: "p" };

  it("adds product and variant identifiers to every plan", () => {
    const policy = buildPolicy("m", [
      reviewable("products", "name"),
      reviewable("products", "id"),
      reviewable("product_variants", "id"),
    ]);
    expect(withIdentifiers(plan, policy).fields).toEqual(["product_id", "variant_id", "name"]);
  });

  it("does not duplicate an identifier the planner already chose", () => {
    const policy = buildPolicy("m", [reviewable("products", "id"), reviewable("product_variants", "id")]);
    expect(withIdentifiers({ ...plan, fields: ["product_id"] }, policy).fields).toEqual(["variant_id", "product_id"]);
  });

  it("never adds an identifier the merchant has not made reviewable", () => {
    const policy = buildPolicy("m", [reviewable("products", "name")]);
    expect(withIdentifiers(plan, policy).fields).toEqual(["name"]);
  });

  it("treats an unknown category as unclassified", () => {
    const policy = buildPolicy("m", [{ resource: "products", field_name: "name", category: "public" }]);
    expect(policy.resources.products!.fields).toEqual({});
  });
});
