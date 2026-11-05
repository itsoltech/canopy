import type { ProviderKey } from "#lib/features/threads/providers.ts";
import { instanceKeyOf, providerName, type ModelOption } from "./catalog.ts";

/**
 * The model picker's provider instances: one rail tab each, in the options' order. An instance whose provider
 * has others (in the list or on the worker) is named in its tab, in favorite rows and in the composer chip.
 */
export interface PickerInstance {
  /** `instanceKeyOf` of its options. */
  readonly key: string;
  readonly provider: ProviderKey;
  readonly profileId: string;
  readonly name: string;
  readonly accent: string;
  /** Another instance of the provider exists: show the instance's accent and name. */
  readonly shared: boolean;
}

export function pickerInstances(options: readonly ModelOption[]): PickerInstance[] {
  const byKey = new Map<string, ModelOption>();

  for (const option of options) if (!byKey.has(instanceKeyOf(option))) byKey.set(instanceKeyOf(option), option);
  const firsts = [...byKey.values()];

  return firsts.map((o) => ({
    key: instanceKeyOf(o),
    provider: o.provider,
    profileId: o.profileId,
    name: o.profileName,
    accent: o.accent,
    shared: o.sharedProvider || firsts.some((other) => other !== o && other.provider === o.provider),
  }));
}

/** The tab's label and tooltip: the provider, with the instance's name when the provider has several. */
export const instanceTitle = (instance: Pick<PickerInstance, "provider" | "name" | "shared">): string =>
  instance.shared ? `${providerName(instance.provider)} · ${instance.name}` : providerName(instance.provider);
