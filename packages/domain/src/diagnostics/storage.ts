import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";

export const STORAGE_CATEGORIES = ["logs", "data", "cache", "application", "database"] as const;

/** Rebuild authenticated source reports from closed labels; drop unknown protobuf fields. */
export function sanitizeStorage(value: ui.DiagnosticsStorage | undefined, component?: string) {
  if (
    !value ||
    !["measuring", "ready", "partial", "unavailable"].includes(value.status) ||
    !["gateway", "worker", "desktop"].includes(value.component) ||
    (component && value.component !== component) ||
    value.sampledAtMs < 0n ||
    value.sampledAtMs > BigInt(Number.MAX_SAFE_INTEGER) ||
    !Number.isFinite(value.sampleAgeMs) ||
    value.sampleAgeMs < 0 ||
    (["ready", "partial"].includes(value.status) && value.sampledAtMs === 0n) ||
    value.categories.length > STORAGE_CATEGORIES.length
  )
    return;

  const categories: ui.DiagnosticsStorageCategory[] = [];
  const seen = new Set<string>();

  for (const row of value.categories) {
    if (
      !STORAGE_CATEGORIES.some((category) => category === row.category) ||
      seen.has(row.category) ||
      row.bytes < 0n ||
      row.bytes > BigInt(Number.MAX_SAFE_INTEGER)
    )
      return;

    seen.add(row.category);
    categories.push(create(ui.DiagnosticsStorageCategorySchema, { category: row.category, bytes: row.bytes }));
  }

  return create(ui.DiagnosticsStorageSchema, {
    status: value.status,
    component: value.component,
    sampledAtMs: value.sampledAtMs,
    sampleAgeMs: value.sampleAgeMs,
    categories,
  });
}
