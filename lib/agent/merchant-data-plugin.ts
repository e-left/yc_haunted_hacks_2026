export type DataClassification = {
  merchantId: string;
  resource: string;
  fieldName: string;
  category: "public" | "private" | "custodial" | "reviewable";
};

export type DraftPlan = {
  resource: string;
  outputFields: string[];
  filterFields: string[];
};

// The caller supplies classifications from trusted merchant configuration.
// This interface exposes planning metadata only; it cannot read or query rows.
export function createMerchantDataPlugin(
  merchantId: string,
  classifications: readonly DataClassification[],
) {
  const fields = new Map<string, Set<string>>();
  for (const classification of classifications) {
    if (classification.merchantId !== merchantId || !["public", "reviewable"].includes(classification.category)) continue;
    const names = fields.get(classification.resource) ?? new Set<string>();
    names.add(classification.fieldName);
    fields.set(classification.resource, names);
  }

  return {
    planningFields() {
      return Array.from(fields, ([resource, names]) => ({ resource, fields: Array.from(names).sort() }))
        .sort((a, b) => a.resource.localeCompare(b.resource));
    },

    validateDraft(plan: DraftPlan) {
      const permitted = fields.get(plan.resource);
      return Boolean(permitted && plan.outputFields.length &&
        [...plan.outputFields, ...plan.filterFields].every((field) => permitted.has(field)));
    },
  };
}
