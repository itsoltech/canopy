import type { ModelOption } from "#lib/features/models/catalog.ts";
import type { ProviderKey } from "#lib/features/threads/providers.ts";
import { normalizeColor, type BotAppearance } from "../mascot.ts";

/** Adapter boundary: the caller supplies available instances and their existing picker options. */
export interface BotProviderInstance {
  readonly id: string;
  readonly name: string;
  readonly provider: ProviderKey;
  readonly models: readonly ModelOption[];
  readonly modelsByWorker?: ReadonlyMap<string, readonly ModelOption[]>;
}

export interface BotAppearanceDraft extends BotAppearance {
  name: string;
}

export interface CreateBotDraft extends BotAppearanceDraft {
  providerInstanceId: string;
  workerId: string;
  model: string;
  /** undefined means the selected model's default. */
  effort: string | undefined;
}

/** Ignore exactly one original name when editing; other duplicates still count. */
export function nameError(name: string, existingNames: readonly string[], originalName?: string): string | undefined {
  const key = (value: string) => value.trim().normalize("NFC").toLowerCase();
  const normalized = key(name);

  if (!normalized) return "Give your bot a name.";
  let skippedOriginal = false;

  const duplicate = existingNames.some((existing) => {
    if (!skippedOriginal && originalName !== undefined && key(existing) === key(originalName)) {
      skippedOriginal = true;

      return false;
    }

    return key(existing) === normalized;
  });

  return duplicate ? "A bot with this name already exists. Choose another name." : undefined;
}

export function appearanceError(
  draft: BotAppearanceDraft,
  existingNames: readonly string[],
  originalName?: string,
): string | undefined {
  return (
    nameError(draft.name, existingNames, originalName) ??
    (!normalizeColor(draft.color) ? "Enter a color as #RGB or #RRGGBB." : undefined)
  );
}

/** Revalidate against live props immediately before invoking the caller. */
export function selectionError(
  instances: readonly BotProviderInstance[],
  instanceId: string,
  option: ModelOption | undefined,
  effort: string | undefined,
): string | undefined {
  const instance = instances.find((i) => i.id === instanceId);

  if (!instance || !option || !instance.models.some((m) => m.key === option.key))
    return "Choose an available provider instance and model.";

  if (effort !== undefined && !option.efforts.some((e) => e.id === effort))
    return "Choose an effort supported by this model.";

  return undefined;
}
