import type { ModelInfo as ClaudeModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ModelInit } from "./models.ts";

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** Format a concrete wire id, without a table of model releases or alias targets. */
export function concreteModelName(id: string): string {
  const claude =
    /^claude-(?:([a-z]+)-(\d+(?:[-.]\d{1,2})*)|(\d+(?:[-.]\d{1,2})*)-([a-z]+))(?:-\d{8})?(\[\d+(?:\.\d+)?[mk]\])?$/i.exec(
      id,
    );

  if (claude) {
    const family = claude[1] ?? claude[4] ?? "";
    const version = (claude[2] ?? claude[3] ?? "").replaceAll("-", ".");

    return `Claude ${capitalize(family)} ${version}${claude[5] ? ` · ${claude[5].slice(1, -1).toUpperCase()} context` : ""}`;
  }

  if (/^(?:gpt|grok)-\d/i.test(id)) {
    return id
      .split("-")
      .map((part, index) => (index === 0 && part === "gpt" ? "GPT" : capitalize(part)))
      .join(" ");
  }

  return id;
}

/** SDK aliases keep their wire value; only the label is resolved. */
export function claudeModelName(model: ClaudeModelInfo): string {
  const context =
    /\[(\d+(?:\.\d+)?[mk])\]/i.exec(model.value)?.[1] ??
    /\b(\d+(?:\.\d+)?[mk])\s+(?:token\s+)?context\b/i.exec(`${model.displayName} ${model.description}`)?.[1];

  const suffix = context ? ` · ${context.toUpperCase()} context` : "";

  for (const id of [model.resolvedModel, model.value]) {
    if (!id) continue;
    const name = concreteModelName(id);

    if (name !== id) return name.includes(" · ") ? name : name + suffix;
  }

  // Some SDK versions only put the concrete name in the label or description.
  for (const text of [model.displayName, model.description]) {
    const concrete = /\b(?:Claude\s+)?([A-Z][a-z]+)\s+(\d+(?:\.\d+)*)(?:\s+(1M))?\b/.exec(text);

    if (concrete) return `Claude ${concrete[1]} ${concrete[2]}${suffix || (concrete[3] ? " · 1M context" : "")}`;
  }

  return (model.displayName || model.resolvedModel || model.value) + suffix;
}

/** One row per concrete name and variant; keep all accepted wire ids without offering duplicate rows. */
export function deduplicateModels(models: readonly ModelInit[]): ModelInit[] {
  const rows = new Map<string, ModelInit>();

  const rank = (model: ModelInit) =>
    Number(model.id === "default") * 4 + Number(Boolean(model.hidden)) * 2 + Number(Boolean(model.legacy));

  for (const model of models) {
    const key = (model.displayName || concreteModelName(model.resolvedModel || model.id || "")).trim().toLowerCase();
    const previous = rows.get(key);

    if (!previous) {
      rows.set(key, { ...model });
      continue;
    }

    const kept = rank(model) < rank(previous) ? model : previous;

    const aliases = new Set([
      previous.id,
      previous.resolvedModel,
      ...(previous.aliases ?? []),
      model.id,
      model.resolvedModel,
      ...(model.aliases ?? []),
    ]);

    rows.set(key, {
      ...kept,
      isDefault: Boolean(previous.isDefault || model.isDefault),
      hidden: Boolean(previous.hidden && model.hidden),
      legacy: Boolean(previous.legacy && model.legacy),
      aliases: [...aliases].filter((id): id is string => Boolean(id) && id !== kept.id && id !== kept.resolvedModel),
    });
  }

  return [...rows.values()];
}

interface VersionedFamily {
  readonly family: string;
  readonly version: readonly number[];
}

function versionedFamily(model: ModelInit): VersionedFamily | undefined {
  const id = model.resolvedModel || model.id || "";
  const formatted = concreteModelName(id);

  const name = model.displayName?.includes(" · ")
    ? model.displayName
    : formatted !== id
      ? formatted
      : model.displayName || id;

  const match = /^(.+?)\s+(\d+(?:\.\d+)*)(.*)$/.exec(name);

  if (!match) return undefined;

  return {
    family: `${match[1]}${match[3]}`.toLowerCase(),
    version: match[2]!.split(".").map(Number),
  };
}

function newer(left: readonly number[], right: readonly number[]): boolean {
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);

    if (difference !== 0) return difference > 0;
  }

  return false;
}

/** Only compare versions within the same family and variant, in this profile's actual catalog. */
export function classifyLegacyModels(models: readonly ModelInit[]): ModelInit[] {
  models = deduplicateModels(models);
  const versions = models.map(versionedFamily);

  return models.map((model, index) => {
    const own = versions[index];

    const legacy =
      model.legacy ||
      model.hidden ||
      Boolean(
        own && versions.some((candidate) => candidate?.family === own.family && newer(candidate.version, own.version)),
      );

    return { ...model, legacy: Boolean(legacy) };
  });
}

/**
 * The lists of the catalog, one per provider + instance: the alias dedupe and the legacy marks run within each
 * list, never across instances (a native and a proxy instance of one harness both list "Claude Opus 5.5").
 */
export function classifyInstanceCatalogs<T extends { readonly models?: readonly ModelInit[] | undefined }>(
  lists: readonly T[],
): (T & { models: ModelInit[] })[] {
  return lists.map((list) => ({ ...list, models: classifyLegacyModels(list.models ?? []) }));
}
