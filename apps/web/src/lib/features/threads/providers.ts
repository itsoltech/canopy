import { Provider, type ui } from "@canopy/contracts";

/** Providers a thread can run on, as sent by forms (enum key). */
export const providerKeys = ["CLAUDE", "CODEX", "GROK"] as const;

export type ProviderKey = (typeof providerKeys)[number];

const PROVIDER_NAMES = { CLAUDE: "Claude", CODEX: "Codex", GROK: "Grok" } satisfies Record<ProviderKey, string>;

export const providerName = (provider: ProviderKey): string => PROVIDER_NAMES[provider];

export const isProviderKey = (value: string): value is ProviderKey => providerKeys.some((key) => key === value);

export const providerKeyOf = (provider: Provider): ProviderKey | undefined =>
  provider === Provider.CLAUDE
    ? "CLAUDE"
    : provider === Provider.CODEX
      ? "CODEX"
      : provider === Provider.GROK
        ? "GROK"
        : undefined;

/** Providers whose CLI the worker reports as available (installed, logged in). */
function availableProviders(worker: ui.Worker | undefined): ProviderKey[] {
  return providerKeys.filter((key) => worker?.providers.some((p) => p.provider === Provider[key] && p.available));
}

/**
 * The provider instances a new thread can use on the worker (global provider instances, docs/worker-config.md,
 * section 9): those of the provider turned on there and reported available, in the gateway's order (native first).
 */
export function instancesFor(worker: ui.Worker | undefined, key: ProviderKey): ui.WorkerInstance[] {
  return worker?.providerInstances.filter((i) => i.harness === Provider[key] && i.enabled && i.available) ?? [];
}

/** A thread's instance on its worker, also when it is turned off or unavailable there (it keeps it for life). */
export function instanceOf(
  worker: ui.Worker | undefined,
  key: ProviderKey,
  profileId: string,
): ui.WorkerInstance | undefined {
  return worker?.providerInstances.find((i) => i.harness === Provider[key] && i.id === (profileId || "native"));
}

/**
 * Form value of an instance id (settings store it so): the native instance is the empty id (the worker's
 * default login).
 */
export const profileIdValue = (id: string): string => (id === "native" ? "" : id);
export const instanceValue = (instance: Pick<ui.WorkerInstance, "id">): string => profileIdValue(instance.id);

/** The label the user gave the instance, else its id ("Device login" for the built-in one). */
export const instanceLabel = (instance: Pick<ui.WorkerInstance, "label" | "id">): string =>
  instance.label || (instance.id === "native" ? "Device login" : instance.id);

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
    choices: instancesFor(worker, provider).map((instance) => ({
      value: `${provider}:${instanceValue(instance)}`,
      provider,
      profileId: instanceValue(instance),
      label: `${providerName(provider)} · ${instanceLabel(instance)}`,
    })),
  }));
}

/** Models already used with a provider in your threads, newest first (suggestions for the model field). */
export function knownModels(threads: Iterable<ui.Thread>, key: ProviderKey): string[] {
  const sorted = [...threads]
    .filter((t) => t.provider === Provider[key] && t.model)
    .sort((a, b) => Number((b.createdAt?.seconds ?? 0n) - (a.createdAt?.seconds ?? 0n)));

  return [...new Set(sorted.map((t) => t.model))].slice(0, 8);
}
