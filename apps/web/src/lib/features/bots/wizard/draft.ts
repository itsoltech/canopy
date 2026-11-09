import type { ModelOption } from "#lib/features/models/catalog.ts";
import type { ProviderKey } from "#lib/features/threads/providers.ts";
import type { BotAppearance } from "../mascot.ts";

export { nameError, appearanceError } from "@canopy/domain/bot-draft";

/** Adapter boundary: the caller supplies available instances and their existing picker options. */
export interface BotProviderInstance {
  readonly id: string;
  readonly name: string;
  readonly provider: ProviderKey;
  readonly models: readonly ModelOption[];
  readonly modelsByWorker?: ReadonlyMap<string, readonly ModelOption[]>;
  readonly automaticModels?: readonly ModelOption[];
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
