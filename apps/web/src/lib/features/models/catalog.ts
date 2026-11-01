import { Provider, type ModelInfo, type ProfileModels, type ui } from "@open-agents/contracts";
import { modelFor } from "#lib/features/settings/thread-defaults.ts";
import { knownModels, profileIdValue, profilesFor, profileValue, type ProviderKey, providerKeyOf, providerKeys } from "#lib/features/threads/providers.ts";

/**
 * Model options for the pickers: one entry per provider + profile + model, with what the UI shows and
 * the reasoning efforts it accepts. This is the client-side interface the composers use.
 *
 * The models of a profile come from the worker's catalog (`ListModels`, kept live by
 * `OverviewUpdate.models`): its names, descriptions, efforts and default effort; hidden models are left
 * out. A model with no efforts has no effort setting (the picker hides the control). Only a profile the
 * worker has not reported a list for (an offline worker that never did, an older worker) falls back to
 * what the UI knows: the profile's default, the defaults' model, the CLI's aliases and models from your
 * threads, with per-provider stand-in efforts.
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
  /** One line from the catalog ("Fast and affordable model for easier tasks."). */
  readonly description: string;
  /** The model the id runs on when it is an alias (`opus` → `claude-opus-5-5`). */
  readonly resolvedModel: string;
  /** The model the profile uses when none is chosen. */
  readonly isDefault: boolean;
  /** Supported reasoning efforts, lowest first (empty = the model has no effort setting). */
  readonly efforts: readonly EffortLevel[];
  /** The model's default effort; undefined = the provider's own default (shown as "Default"). */
  readonly defaultEffort: string | undefined;
  readonly origin: "catalog" | "default" | "alias" | "recent" | "custom";
  /** The profile's list is incomplete: why (from the catalog). */
  readonly listDetail: string;
}

export interface ModelSources {
  readonly worker: ui.Worker | undefined;
  /** The worker's model catalog (undefined = not reported yet). */
  readonly catalog: ui.WorkerModels | undefined;
  /** Threads whose models are offered again (newest first) when a profile has no catalog. */
  readonly threads: Iterable<ui.Thread>;
  /** Thread defaults (their model per provider is offered first without a catalog). */
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
  ultra: { label: "Ultra", short: "Ultra" },
};

export function effortLevel(id: string): EffortLevel {
  const known = effortLabels[id];
  return { id, label: known?.label ?? capitalize(id), short: known?.short ?? capitalize(id) };
}

/** Per-provider stand-ins, only for profiles without a catalog. */
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

/** The catalog's list for a provider + profile (the catalog names the native profile "native"). */
export function profileCatalog(catalog: ui.WorkerModels | undefined, provider: ProviderKey, profileId: string): ProfileModels | undefined {
  return catalog?.profiles.find((p) => p.provider === Provider[provider] && profileIdValue(p.profileId) === profileId);
}

/** The catalog entry for a model id: by id, else the model an alias resolves to. Hidden ones too. */
const catalogEntry = (list: ProfileModels | undefined, model: string): ModelInfo | undefined =>
  model ? (list?.models.find((m) => m.id === model) ?? list?.models.find((m) => m.resolvedModel === model)) : list?.models.find((m) => m.isDefault);

function fromCatalog(provider: ProviderKey, profileId: string, profileName: string, info: ModelInfo, list: ProfileModels): ModelOption {
  return {
    key: modelKey(provider, profileId, info.id),
    provider,
    profileId,
    profileName,
    model: info.id,
    name: info.displayName && info.displayName !== info.id ? info.displayName : modelDisplayName(info.id),
    description: info.description,
    resolvedModel: info.resolvedModel,
    isDefault: info.isDefault,
    efforts: info.efforts.map(effortLevel),
    defaultEffort: info.defaultEffort || undefined,
    origin: "catalog",
    listDetail: list.detail,
  };
}

/** An option outside the catalog's list (a model typed by hand, a fallback entry). */
function standIn(provider: ProviderKey, profileId: string, profileName: string, model: string, origin: ModelOption["origin"], list: ProfileModels | undefined): ModelOption {
  // A profile with a catalog does not know the model's efforts: no effort setting rather than a guess.
  const effort = list ? undefined : fallbackEfforts[provider];
  return {
    key: modelKey(provider, profileId, model),
    provider,
    profileId,
    profileName,
    model,
    name: modelDisplayName(model),
    description: "",
    resolvedModel: "",
    isDefault: !model,
    efforts: effort?.efforts.map(effortLevel) ?? [],
    defaultEffort: effort?.default,
    origin,
    listDetail: list?.detail ?? "",
  };
}

/**
 * The option for a model on a profile, also when the list does not offer it (a hidden or retired model,
 * one typed by hand): what the catalog knows about it, else a custom entry. "" = the profile's default.
 */
export function modelOption(
  provider: ProviderKey,
  profileId: string,
  profileName: string,
  model: string,
  catalog: ui.WorkerModels | undefined,
  origin: ModelOption["origin"] = "custom",
): ModelOption {
  const list = profileCatalog(catalog, provider, profileId);
  const info = catalogEntry(list, model);
  if (!info || !list) return standIn(provider, profileId, profileName, model, origin, list);
  const option = fromCatalog(provider, profileId, profileName, info, list);
  // An alias's resolved id keeps the id it was given (that is what the thread stores and sends).
  return info.id === model || !model ? option : { ...option, key: modelKey(provider, profileId, model), model, name: modelDisplayName(model), isDefault: false };
}

/** Models of one provider on one profile, in the catalog's order (default first without one). */
function profileModels(provider: ProviderKey, profileId: string, profileName: string, sources: ModelSources): ModelOption[] {
  const list = profileCatalog(sources.catalog, provider, profileId);
  const shown = list?.models.filter((m) => !m.hidden) ?? [];
  if (list && shown.length > 0) return shown.map((info) => fromCatalog(provider, profileId, profileName, info, list));
  // No list (or an empty one that says why): what the UI knows.
  const fromDefaults = sources.defaults ? modelFor(sources.defaults, Provider[provider]) : "";
  const entries: { model: string; origin: ModelOption["origin"] }[] = [
    { model: "", origin: "default" },
    ...(fromDefaults ? [{ model: fromDefaults, origin: "default" as const }] : []),
    ...aliases[provider].map((model) => ({ model, origin: "alias" as const })),
    ...knownModels(sources.threads, provider).map((model) => ({ model, origin: "recent" as const })),
  ];
  const seen = new Set<string>();
  return entries.filter((e) => !seen.has(e.model) && seen.add(e.model)).map((e) => standIn(provider, profileId, profileName, e.model, e.origin, undefined));
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
    return named.flatMap((profile) => profileModels(provider, profile.id, profile.name, sources));
  });
}

/**
 * The listed option for a model id on a provider + profile ("" = the profile's default model), matching
 * an alias's resolved model too.
 */
export function findOption(options: readonly ModelOption[], provider: ProviderKey, profileId: string, model: string): ModelOption | undefined {
  const onProfile = options.filter((o) => o.provider === provider && o.profileId === profileId);
  if (!model) return onProfile.find((o) => o.isDefault) ?? onProfile[0];
  return onProfile.find((o) => o.model === model) ?? onProfile.find((o) => o.resolvedModel === model);
}

/**
 * What a thread can switch to: models of its provider and profile (it keeps both for life), and its
 * default model as an option (`current`, listed or not; undefined for an unknown provider).
 */
export function threadModelOptions(thread: ui.Thread, sources: Omit<ModelSources, "only" | "defaults">): { options: ModelOption[]; current: ModelOption | undefined } {
  const provider = providerKeyOf(thread.provider);
  if (!provider) return { options: [], current: undefined };
  const profileId = profileIdValue(thread.providerProfileId);
  const options = modelOptions({ ...sources, only: { provider, profileId } });
  const current = findOption(options, provider, profileId, thread.model) ?? modelOption(provider, profileId, profileId || "native", thread.model, sources.catalog, "recent");
  return { options, current };
}

/** The effort `option` runs with when none is chosen: `inherited` if the model takes it, else its default. */
export function effectiveEffort(option: ModelOption, inherited: string | undefined): string | undefined {
  return inherited && option.efforts.some((e) => e.id === inherited) ? inherited : option.defaultEffort;
}

/** Text the picker's search matches against. */
export const searchText = (option: ModelOption): string =>
  `${option.name} ${option.model} ${option.resolvedModel} ${option.description} ${option.profileName} ${providerName(option.provider)}`;

/** Model ids worth suggesting for a provider in free-text fields: every catalog's visible models, aliases, then recent ones. */
export function suggestedModels(provider: ProviderKey, threads: Iterable<ui.Thread>, catalogs: Iterable<ui.WorkerModels> = []): string[] {
  const listed = [...catalogs].flatMap((c) => c.profiles.filter((p) => p.provider === Provider[provider]).flatMap((p) => p.models.filter((m) => !m.hidden).map((m) => m.id)));
  return [...new Set([...listed, ...aliases[provider], ...knownModels(threads, provider)])];
}

/** Display name of a model id for labels outside the picker (catalog name when a worker lists it). */
export function nameOfModel(model: string, catalogs: Iterable<ui.WorkerModels>): string {
  for (const catalog of catalogs) {
    for (const list of catalog.profiles) {
      const info = list.models.find((m) => m.id === model);
      if (info?.displayName && info.displayName !== info.id) return info.displayName;
    }
  }
  return modelDisplayName(model);
}
