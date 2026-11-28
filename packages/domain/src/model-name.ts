import type { ModelChange } from "@canopy/contracts";

/**
 * Readable name of a model id the catalog does not name:
 * `claude-opus-5-5` → "Opus 5.5", `opus` → "Opus", `gpt-5.5-codex` → "GPT-5.5 Codex".
 */
export function modelDisplayName(model: string): string {
  if (!model) return "Default model";
  const claude = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:-(\d+)(?:-(\d{1,2}))?)?(?:-\d{8})?(\[1m\])?$/i.exec(model);

  if (claude) {
    const version = claude[2] ? (claude[3] ? `${claude[2]}.${claude[3]}` : claude[2]) : "";

    return [capitalize(claude[1]!), version, claude[4] ? "1M" : ""].filter(Boolean).join(" ");
  }

  const gpt = /^gpt-([\d.]+[a-z]?)(?:-(.+))?$/i.exec(model);

  if (gpt) return [`GPT-${gpt[1]}`, ...(gpt[2]?.split("-").map(capitalize) ?? [])].join(" ");

  return model;
}

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

export const effortDisplayName = (id: string): string => (id === "xhigh" ? "Extra high" : capitalize(id));

/** Use the catalog names captured at dispatch, even when a worker later renames or removes a model. */
export function modelChangeLabel(change: ModelChange): string {
  const modelName = (model: string, name: string) => (name && name !== model ? name : modelDisplayName(model));
  let before = modelName(change.previousModel, change.previousModelName);
  let after = modelName(change.model, change.modelName);

  if (before === after && change.previousModel !== change.model && change.previousEffort === change.effort) {
    before = change.previousModel || before;
    after = change.model || after;
  }

  if (change.previousEffort || change.effort) {
    before += ` ${effortDisplayName(change.previousEffort) || "default effort"}`;
    after += ` ${effortDisplayName(change.effort) || "default effort"}`;
  }

  return `${before} → ${after}`;
}
