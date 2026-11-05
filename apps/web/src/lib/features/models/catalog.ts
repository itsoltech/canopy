import { Provider, type ModelInfo, type ProfileModels, type ui } from "@canopy/contracts";
import { modelFor } from "#lib/features/settings/thread-defaults.ts";
import {
  instanceLabel,
  instanceOf,
  instancesFor,
  instanceValue,
  knownModels,
  profileIdValue,
  providerName,
  type ProviderKey,
  providerKeyOf,
  providerKeys,
} from "#lib/features/threads/providers.ts";

/**
 * Model options for the pickers: one entry per provider + profile + model, with what the UI shows and
 * the reasoning efforts it accepts. This is the client-side interface the composers use.
 *
 * Profiles are the worker's provider instances (global, turned on per worker; docs/worker-config.md, section 9):
 * a new thread sees only those turned on and available on its worker. The models of an instance come from the
 * worker's catalog (`ListModels`, kept live by `OverviewUpdate.models`) with the instance's choices applied by the
 * gateway: its names, descriptions, efforts and default effort, favorites first; hidden models are left out. A model with no efforts has no effort setting (the picker hides the control). Only a profile the
 * worker has not reported a list for (an offline worker that never did, an older worker) falls back to
 * what the UI knows: the profile's default, the defaults' model, the CLI's aliases and models from your
 * threads, with per-provider stand-in efforts.
 */

export interface EffortLevel {
  readonly id: string;
  readonly label: string;
}

export interface ModelOption {
  /** Stable id: provider, profile and model (`CLAUDE:cliproxyapi:claude-opus-5-5`). */
  readonly key: string;
  readonly provider: ProviderKey;
  /** Profile id as the forms send it ("" = the worker's native login). */
  readonly profileId: string;
  /** The instance's label. */
  readonly profileName: string;
  /** The instance's accent color (#rrggbb, "" = none), a marker in the picker. */
  readonly accent: string;
  /** Place among the instance's favorites (undefined = not a favorite). */
  readonly favoriteIndex: number | undefined;
  /** Model id sent to the provider ("" = the profile's default model). */
  readonly model: string;
  readonly name: string;
  /** One line from the catalog ("Fast and affordable model for easier tasks."). */
  readonly description: string;
  /** The model the id runs on when it is an alias (`opus` → `claude-opus-5-5`). */
  readonly resolvedModel: string;
  /** The model the profile uses when none is chosen. */
  readonly isDefault: boolean;
  readonly legacy: boolean;
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

const effortLabels = new Map<string, string>([
  ["none", "None"],
  ["minimal", "Minimal"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Max"],
  ["ultra", "Ultra"],
]);

export function effortLevel(id: string): EffortLevel {
  const known = effortLabels.get(id);

  return { id, label: known ?? capitalize(id) };
}

/** Per-provider stand-ins, only for profiles without a catalog. */
const fallbackEfforts: Record<ProviderKey, { readonly efforts: readonly string[]; readonly default: string }> = {
  CLAUDE: { efforts: ["low", "medium", "high", "xhigh", "max"], default: "high" },
  CODEX: { efforts: ["low", "medium", "high", "xhigh"], default: "medium" },
  GROK: { efforts: [], default: "" },
};

/** Model aliases the provider's CLI resolves itself (always valid, whatever the current versions are). */
const aliases: Record<ProviderKey, readonly string[]> = {
  CLAUDE: ["opus", "sonnet", "haiku"],
  CODEX: [],
  GROK: [],
};

export const modelKey = (provider: ProviderKey, profileId: string, model: string): string =>
  `${provider}:${profileId}:${model}`;

export { providerName };

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

/**
 * A model's name without its family prefix, as ChatGPT names the model under the effort:
 * "GPT-6.1-Sol" → "6.1 Sol", "GPT-5.5 Codex" → "5.5 Codex", "Claude Opus 5.5" → "Opus 5.5"; others as they are.
 */
export function shortModelName(name: string): string {
  const gpt = /^gpt-(\d.*)$/i.exec(name);

  if (gpt) return gpt[1]!.replaceAll("-", " ");
  const claude = /^claude (\S.*)$/i.exec(name);

  return claude ? claude[1]! : name;
}

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** The catalog's list for a provider + profile (the catalog names the native profile "native"). */
export function profileCatalog(
  catalog: ui.WorkerModels | undefined,
  provider: ProviderKey,
  profileId: string,
): ProfileModels | undefined {
  return catalog?.profiles.find((p) => p.provider === Provider[provider] && profileIdValue(p.profileId) === profileId);
}

/** The catalog entry for a model id: by id, else the model an alias resolves to. Hidden ones too. */
const catalogEntry = (list: ProfileModels | undefined, model: string): ModelInfo | undefined =>
  model
    ? (list?.models.find((m) => m.id === model) ?? list?.models.find((m) => m.resolvedModel === model))
    : list?.models.find((m) => m.isDefault);

/** What the options of an instance share: its label, accent and favorites. */
interface InstanceMeta {
  readonly name: string;
  readonly accent: string;
  readonly favorites: readonly string[];
}

const plainMeta = (name: string): InstanceMeta => ({ name, accent: "", favorites: [] });

const favoriteIndexOf = (meta: InstanceMeta, model: string) =>
  meta.favorites.includes(model) ? meta.favorites.indexOf(model) : undefined;

function fromCatalog(
  provider: ProviderKey,
  profileId: string,
  meta: InstanceMeta,
  info: ModelInfo,
  list: ProfileModels,
): ModelOption {
  return {
    key: modelKey(provider, profileId, info.id),
    provider,
    profileId,
    profileName: meta.name,
    accent: meta.accent,
    favoriteIndex: favoriteIndexOf(meta, info.id),
    model: info.id,
    name: info.displayName && info.displayName !== info.id ? info.displayName : modelDisplayName(info.id),
    description: info.description,
    resolvedModel: info.resolvedModel,
    isDefault: info.isDefault,
    legacy: info.legacy,
    efforts: info.efforts.map(effortLevel),
    defaultEffort: info.defaultEffort || undefined,
    origin: "catalog",
    listDetail: list.detail,
  };
}

/** An option outside the catalog's list (a model typed by hand, a fallback entry). */
function standIn(
  provider: ProviderKey,
  profileId: string,
  meta: InstanceMeta,
  model: string,
  origin: ModelOption["origin"],
  list: ProfileModels | undefined,
): ModelOption {
  // A profile with a catalog does not know the model's efforts: no effort setting rather than a guess.
  const effort = list ? undefined : fallbackEfforts[provider];

  return {
    key: modelKey(provider, profileId, model),
    provider,
    profileId,
    profileName: meta.name,
    accent: meta.accent,
    favoriteIndex: favoriteIndexOf(meta, model),
    model,
    name: modelDisplayName(model),
    description: "",
    resolvedModel: "",
    isDefault: !model,
    legacy: false,
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
  const meta = plainMeta(profileName);

  if (!info || !list) return standIn(provider, profileId, meta, model, origin, list);
  const option = fromCatalog(provider, profileId, meta, info, list);

  // An alias's resolved id keeps the id it was given (that is what the thread stores and sends).
  return info.id === model || !model
    ? option
    : { ...option, key: modelKey(provider, profileId, model), model, isDefault: false };
}

/** Models of one provider on one profile, in the catalog's order (default first without one). */
function profileModels(
  provider: ProviderKey,
  profileId: string,
  meta: InstanceMeta,
  sources: ModelSources,
): ModelOption[] {
  const list = profileCatalog(sources.catalog, provider, profileId);
  const shown = list?.models.filter((m) => !m.hidden) ?? [];

  if (list && shown.length > 0) return shown.map((info) => fromCatalog(provider, profileId, meta, info, list));
  // No list (or an empty one that says why): what the UI knows.
  const fromDefaults = sources.defaults ? modelFor(sources.defaults, Provider[provider]) : "";

  const entries: { model: string; origin: ModelOption["origin"] }[] = [
    { model: "", origin: "default" },
    ...(fromDefaults ? [{ model: fromDefaults, origin: "default" as const }] : []),
    ...aliases[provider].map((model) => ({ model, origin: "alias" as const })),
    ...knownModels(sources.threads, provider).map((model) => ({ model, origin: "recent" as const })),
  ];

  const seen = new Set<string>();

  return entries.flatMap((e) => {
    if (seen.has(e.model)) return [];
    seen.add(e.model);

    return [standIn(provider, profileId, meta, e.model, e.origin, undefined)];
  });
}

/**
 * Every option the worker can run now: its available providers × instances turned on and available there × models.
 * A thread (`only`) keeps its instance, also when it is turned off, unavailable or the worker is offline.
 */
export function modelOptions(sources: ModelSources): ModelOption[] {
  const providers = sources.only ? [sources.only.provider] : providerKeys;

  return providers.flatMap((provider) => {
    const available = sources.worker?.providers.some((p) => providerKeyOf(p.provider) === provider && p.available);

    if (!available && !sources.only) return [];

    const meta = (i: ui.WorkerInstance): InstanceMeta => ({
      name: instanceLabel(i),
      accent: i.accentColor,
      favorites: i.favorites,
    });

    if (sources.only) {
      const own = instanceOf(sources.worker, provider, sources.only.profileId);

      return profileModels(
        provider,
        sources.only.profileId,
        own ? meta(own) : plainMeta(sources.only.profileId || "native"),
        sources,
      );
    }

    return instancesFor(sources.worker, provider).flatMap((instance) =>
      profileModels(provider, instanceValue(instance), meta(instance), sources),
    );
  });
}

/**
 * The listed option for a model id on a provider + profile ("" = the profile's default model), matching
 * an alias's resolved model too.
 */
export function findOption(
  options: readonly ModelOption[],
  provider: ProviderKey,
  profileId: string,
  model: string,
): ModelOption | undefined {
  const onProfile = options.filter((o) => o.provider === provider && o.profileId === profileId);

  if (!model) return onProfile.find((o) => o.isDefault) ?? onProfile[0];

  return onProfile.find((o) => o.model === model) ?? onProfile.find((o) => o.resolvedModel === model);
}

export interface ThreadModelOptions {
  options: ModelOption[];
  current: ModelOption | undefined;
}

/**
 * What a thread can switch to: models of its provider and profile (it keeps both for life), and its
 * default model as an option (`current`, listed or not; undefined for an unknown provider).
 */
export function threadModelOptions(
  thread: ui.Thread,
  sources: Omit<ModelSources, "only" | "defaults">,
): ThreadModelOptions {
  const provider = providerKeyOf(thread.provider);

  if (!provider) return { options: [], current: undefined };
  const profileId = profileIdValue(thread.providerProfileId);
  const options = modelOptions({ ...sources, only: { provider, profileId } });

  const current =
    findOption(options, provider, profileId, thread.model) ??
    modelOption(provider, profileId, profileId || "native", thread.model, sources.catalog, "recent");

  return { options, current };
}

/** The effort `option` runs with when none is chosen: `inherited` if the model takes it, else its default. */
export function effectiveEffort(option: ModelOption, inherited: string | undefined): string | undefined {
  return inherited && option.efforts.some((e) => e.id === inherited) ? inherited : option.defaultEffort;
}

export interface TurnOverride {
  model?: string;
  effort?: string;
}

/**
 * What a message sends for its turn (SendMessage): a model other than the thread's default (`current`),
 * the chosen effort; without one the thread's effort, unless the model does not take it (then the model's
 * default). Empty object = the thread's defaults.
 */
export function turnOverride(
  option: ModelOption | undefined,
  current: ModelOption | undefined,
  effort: string | undefined,
  threadEffort: string,
): TurnOverride {
  const model = option && current && option.key !== current.key ? option.model : undefined;

  const fallback =
    option && threadEffort && option.efforts.length > 0 && !option.efforts.some((e) => e.id === threadEffort)
      ? option.defaultEffort
      : undefined;

  const sent = effort ?? fallback;

  return { ...(model !== undefined && { model }), ...(sent && { effort: sent }) };
}

/** Text the picker's search matches against. */
export const searchText = (option: ModelOption): string =>
  `${option.name} ${option.model} ${option.resolvedModel} ${option.description} ${option.profileName} ${providerName(option.provider)}`;

/** Model ids worth suggesting for a provider in free-text fields: every catalog's visible models, aliases, then recent ones. */
export function suggestedModels(
  provider: ProviderKey,
  threads: Iterable<ui.Thread>,
  catalogs: Iterable<ui.WorkerModels> = [],
): string[] {
  const listed = [...catalogs].flatMap((c) =>
    c.profiles
      .filter((p) => p.provider === Provider[provider])
      .flatMap((p) => p.models.filter((m) => !m.hidden).map((m) => m.id)),
  );

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
