import { Provider, type ui } from "@open-agents/contracts";
import { modelFor } from "#lib/features/settings/thread-defaults.ts";
import { knownModels, profilesFor, profileValue, type ProviderKey, providerKeyOf, providerKeys } from "#lib/features/threads/providers.ts";

/**
 * Model options for the pickers: one entry per provider + profile + model, with what the UI shows and
 * the reasoning efforts it accepts. This is the client-side interface the composers use.
 *
 * Today it is assembled from what the contract already has: the profiles a worker reports
 * (`ui.Worker.profiles`), models seen on your threads, the defaults' model per provider and the CLI's
 * model aliases; efforts and display names are local fallbacks. PENDING backend: the gateway's model
 * catalog per worker/profile replaces `profileModels` (and `fallbackEfforts`) — nothing else changes.
 */

export interface EffortLevel {
  readonly id: string;
  readonly label: string;
  /** Label under the slider stop. */
  readonly short: string;
}

export interface ModelOption {
  /** Stable id: provider, profile and model (`CLAUDE:cliproxyapi:claude-opus-5-5`). */
  readonly key: string;
  readonly provider: ProviderKey;
  /** Profile id as the forms send it ("" = the worker's native login). */
  readonly profileId: string;
  /** Profile name as the worker reports it. */
  readonly profileName: string;
  /** Model id sent to the provider ("" = the profile's default model). */
  readonly model: string;
  readonly name: string;
  /** Supported reasoning efforts, lowest first (empty = the model has no effort setting). */
  readonly efforts: readonly EffortLevel[];
  readonly defaultEffort: string | undefined;
  readonly origin: "catalog" | "default" | "alias" | "recent" | "custom";
}

export interface ModelSources {
  readonly worker: ui.Worker | undefined;
  /** Threads whose models are offered again (newest first). */
  readonly threads: Iterable<ui.Thread>;
  /** Thread defaults (their model per provider is offered first). */
  readonly defaults?: ui.ThreadDefaults | undefined;
  /** Only this provider and profile (a running thread keeps both). */
  readonly only?: { readonly provider: ProviderKey; readonly profileId: string } | undefined;
}

const effortLabels: Record<string, { label: string; short: string }> = {
  none: { label: "None", short: "None" },
  minimal: { label: "Minimal", short: "Minimal" },
  low: { label: "Low", short: "Low" },
  medium: { label: "Medium", short: "Medium" },
  high: { label: "High", short: "High" },
  xhigh: { label: "Extra high", short: "X-High" },
  max: { label: "Max", short: "Max" },
};

export function effortLevel(id: string): EffortLevel {
  const known = effortLabels[id];
  return { id, label: known?.label ?? capitalize(id), short: known?.short ?? capitalize(id) };
}

/** PENDING backend: per-model efforts and default come from the catalog; these are per-provider stand-ins. */
const fallbackEfforts: Record<ProviderKey, { readonly efforts: readonly string[]; readonly default: string }> = {
  CLAUDE: { efforts: ["low", "medium", "high", "xhigh", "max"], default: "high" },
  CODEX: { efforts: ["low", "medium", "high", "xhigh"], default: "medium" },
};

/** Model aliases the provider's CLI resolves itself (always valid, whatever the current versions are). */
const aliases: Record<ProviderKey, readonly string[]> = {
  CLAUDE: ["opus", "sonnet", "haiku"],
  CODEX: [],
};

export const modelKey = (provider: ProviderKey, profileId: string, model: string): string => `${provider}:${profileId}:${model}`;

export const providerName = (provider: ProviderKey): string => (provider === "CLAUDE" ? "Claude" : "Codex");

/**
 * Readable name of a model id until the catalog brings display names:
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

/** One option (also for a model typed by hand). */
export function modelOption(provider: ProviderKey, profileId: string, profileName: string, model: string, origin: ModelOption["origin"]): ModelOption {
  const effort = fallbackEfforts[provider];
  return {
    key: modelKey(provider, profileId, model),
    provider,
    profileId,
    profileName,
    model,
    name: modelDisplayName(model),
    efforts: effort.efforts.map(effortLevel),
    defaultEffort: effort.default,
    origin,
  };
}

/** Models of one provider on one profile, best first. PENDING backend: the catalog's list for the profile. */
function profileModels(provider: ProviderKey, sources: ModelSources): { model: string; origin: ModelOption["origin"] }[] {
  const fromDefaults = sources.defaults ? modelFor(sources.defaults, Provider[provider]) : "";
  const entries: { model: string; origin: ModelOption["origin"] }[] = [
    { model: "", origin: "default" },
    ...(fromDefaults ? [{ model: fromDefaults, origin: "default" as const }] : []),
    ...aliases[provider].map((model) => ({ model, origin: "alias" as const })),
    ...knownModels(sources.threads, provider).map((model) => ({ model, origin: "recent" as const })),
  ];
  const seen = new Set<string>();
  return entries.filter((e) => !seen.has(e.model) && seen.add(e.model));
}

/** Every option the worker can run now: its available providers × profiles × models. */
export function modelOptions(sources: ModelSources): ModelOption[] {
  const providers = sources.only ? [sources.only.provider] : providerKeys;
  return providers.flatMap((provider) => {
    const available = sources.worker?.providers.some((p) => providerKeyOf(p.provider) === provider && p.available);
    if (!available && !sources.only) return [];
    const profiles = profilesFor(sources.worker, provider).filter((p) => !sources.only || profileValue(p) === sources.only.profileId);
    // A thread's profile stays offered even when the worker is offline or no longer reports it.
    const named = profiles.length > 0 ? profiles.map((p) => ({ id: profileValue(p), name: p.id })) : sources.only ? [{ id: sources.only.profileId, name: sources.only.profileId || "native" }] : [];
    const models = profileModels(provider, sources);
    return named.flatMap((profile) => models.map((m) => modelOption(provider, profile.id, profile.name, m.model, m.origin)));
  });
}

/** Text the picker's search matches against. */
export const searchText = (option: ModelOption): string => `${option.name} ${option.model} ${option.profileName} ${providerName(option.provider)}`;
