/**
 * Shared FormData → schema-input mapping for the program forms. Money is
 * parsed from the decimal string into integer cents without ever passing
 * through floating point.
 */

export function parsePriceToCents(raw: string): number {
  const match = /^\s*\$?\s*(\d{1,6})(?:\.(\d{1,2}))?\s*$/.exec(raw);
  if (!match) return NaN;
  const dollars = Number(match[1]);
  const cents = Number((match[2] ?? "").padEnd(2, "0") || "0");
  return dollars * 100 + cents;
}

export function parseFeatureList(raw: string): string[] {
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 20);
}

export function programFieldsFromForm(formData: FormData): Record<string, unknown> {
  const pricingType = String(formData.get("pricingType") ?? "one_time");
  const capacityRaw = String(formData.get("capacity") ?? "").trim();
  return {
    slug: String(formData.get("slug") ?? ""),
    title: String(formData.get("title") ?? ""),
    summary: String(formData.get("summary") ?? ""),
    fullDescription: String(formData.get("fullDescription") ?? ""),
    deliveryMode: String(formData.get("deliveryMode") ?? "online"),
    pricingType,
    priceCents: parsePriceToCents(String(formData.get("price") ?? "")),
    durationValue: Number(formData.get("durationValue") ?? NaN),
    durationUnit: String(formData.get("durationUnit") ?? "week"),
    ...(pricingType === "recurring"
      ? {
          recurrenceInterval: String(formData.get("recurrenceInterval") ?? "month"),
          recurrenceIntervalCount: Number(formData.get("recurrenceIntervalCount") ?? NaN),
        }
      : {}),
    ...(capacityRaw ? { capacity: Number(capacityRaw) } : {}),
    approvalPolicy: String(formData.get("approvalPolicy") ?? "automatic"),
    includedFeatures: parseFeatureList(String(formData.get("includedFeatures") ?? "")),
    cancellationTerms: String(formData.get("cancellationTerms") ?? ""),
    refundPolicy: String(formData.get("refundPolicy") ?? ""),
    visibility: String(formData.get("visibility") ?? "public"),
  };
}
