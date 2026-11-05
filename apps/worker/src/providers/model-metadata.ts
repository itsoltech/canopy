import type { ModelInfo as ClaudeModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ModelInit } from "./models.ts";

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** Format a concrete wire id, without a table of model releases or alias targets. */
export function concreteModelName(id: string): string {
  const claude = /^claude-(?:([a-z]+)-(\d+(?:[-.]\d{1,2})*)|(\d+(?:[-.]\d{1,2})*)-([a-z]+))(?:-\d{8})?(\[1m\])?$/i.exec(
    id,
  );

  if (claude) {
    const family = claude[1] ?? claude[4] ?? "";
    const version = (claude[2] ?? claude[3] ?? "").replaceAll("-", ".");

    return `Claude ${capitalize(family)} ${version}${claude[5] ? " 1M" : ""}`;
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
  for (const id of [model.resolvedModel, model.value]) {
    if (!id) continue;
    const name = concreteModelName(id);

    if (name !== id) return name;
  }

  // Some SDK versions only put the concrete name in the label or description.
  for (const text of [model.displayName, model.description]) {
    const concrete = /\b(?:Claude\s+)?([A-Z][a-z]+)\s+(\d+(?:\.\d+)*)(?:\s+(1M))?\b/.exec(text);

    if (concrete) return `Claude ${concrete[1]} ${concrete[2]}${concrete[3] ? " 1M" : ""}`;
  }

  return model.displayName || model.resolvedModel || model.value;
}

interface VersionedFamily {
  readonly family: string;
  readonly version: readonly number[];
}

function versionedFamily(model: ModelInit): VersionedFamily | undefined {
  const id = model.resolvedModel || model.id || "";
  const formatted = concreteModelName(id);
  const name = formatted !== id ? formatted : model.displayName || id;
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
