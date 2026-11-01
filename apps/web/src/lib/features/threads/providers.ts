import { Provider, type ProviderProfile, type ui } from "@open-agents/contracts";

/** Providers a thread can run on, as sent by forms (enum key). */
export const providerKeys = ["CLAUDE", "CODEX"] as const;
export type ProviderKey = (typeof providerKeys)[number];

export const isProviderKey = (value: string): value is ProviderKey => (providerKeys as readonly string[]).includes(value);
export const providerKeyOf = (provider: Provider): ProviderKey | undefined => (provider === Provider.CLAUDE ? "CLAUDE" : provider === Provider.CODEX ? "CODEX" : undefined);

/** Providers whose CLI the worker reports as available (installed, logged in). */
function availableProviders(worker: ui.Worker | undefined): ProviderKey[] {
  return providerKeys.filter((key) => worker?.providers.some((p) => p.provider === Provider[key] && p.available));
}

/** The worker's available profiles that can serve the provider. */
export function profilesFor(worker: ui.Worker | undefined, key: ProviderKey): ProviderProfile[] {
  return worker?.profiles.filter((p) => p.available && p.providers.includes(Provider[key])) ?? [];
}

/**
 * Form value of a profile id as the worker reports it (settings store it so): the native profile is the
 * empty id (the worker's default login).
 */
export const profileIdValue = (id: string): string => (id === "native" ? "" : id);
export const profileValue = (profile: ProviderProfile): string => profileIdValue(profile.id);

/** One provider + profile choice of the new-thread "agent" pill. */
export interface AgentChoice {
  readonly value: string;
  readonly provider: ProviderKey;
  readonly profileId: string;
  readonly label: string;
}

/** Every provider + profile pair the worker can start, grouped by provider. */
export function agentChoices(worker: ui.Worker | undefined): { provider: ProviderKey; choices: AgentChoice[] }[] {
  return availableProviders(worker).map((provider) => ({
    provider,
    choices: profilesFor(worker, provider).map((profile) => ({
      value: `${provider}:${profileValue(profile)}`,
      provider,
      profileId: profileValue(profile),
      label: `${provider === "CLAUDE" ? "Claude" : "Codex"} · ${profile.id}`,
    })),
  }));
}

/** Models already used with a provider in your threads, newest first (suggestions for the model field). */
export function knownModels(threads: Iterable<ui.Thread>, key: ProviderKey): string[] {
  const sorted = [...threads].filter((t) => t.provider === Provider[key] && t.model).sort((a, b) => Number((b.createdAt?.seconds ?? 0n) - (a.createdAt?.seconds ?? 0n)));
  return [...new Set(sorted.map((t) => t.model))].slice(0, 8);
}
