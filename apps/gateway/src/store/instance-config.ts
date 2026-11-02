import { create } from "@bufbuild/protobuf";
import { ModelInfoSchema, ProfileModelsSchema, Provider, ui, type ProfileModels } from "@open-agents/contracts";

/**
 * Global provider instances, the pure part (docs/worker-config.md, section 9): what a worker gets is the
 * instance's global definition merged with that worker's overrides, as one profile of its configuration
 * (WorkerConfig.profiles, protobuf JSON with secrets as references). Pickers see a catalog with the instance's
 * model choices applied. No database here, so the rules are tested directly.
 */

export type Harness = "claude" | "codex" | "grok";
export type SecretRef = { secretRef: string };

export interface StoredEnvVar {
  name: string;
  value: string | SecretRef;
  secret?: boolean;
}

export interface StoredRuntime {
  binaryPath?: string;
  homePath?: string;
  shadowHomePath?: string;
  launchArgs?: string[];
  ownLogin?: boolean;
}

/** Per-worker overrides; an absent field means the global definition. */
export interface StoredOverrides {
  binaryPath?: string;
  homePath?: string;
  shadowHomePath?: string;
  launchArgs?: string[];
  /** Added or replaced by name (case-insensitive). */
  env?: StoredEnvVar[];
  baseUrl?: string;
  apiKey?: SecretRef;
}

export interface InstanceRow {
  harness: Harness;
  id: string;
  label: string;
  kind: "native" | "endpoint";
  base_url: string;
  api_key: SecretRef | null;
  env: StoredEnvVar[];
  runtime: StoredRuntime;
  accent_color: string;
  favorites: string[];
  hidden_models: string[];
  shown_models: string[];
  custom_models: string[];
  all_workers: boolean;
  built_in: boolean;
  revision: bigint | number | string;
  updated_at: Date;
}

export interface AssignmentRow {
  harness: Harness;
  instance_id: string;
  worker_id: string;
  enabled: boolean | null;
  overrides: StoredOverrides;
}

/** A profile of WorkerConfig.profiles as stored (protobuf JSON, secrets as references, defaults omitted). */
export interface StoredProfile {
  id: string;
  kind: "PROVIDER_PROFILE_KIND_NATIVE" | "PROVIDER_PROFILE_KIND_CLIPROXYAPI";
  providers: ["PROVIDER_CLAUDE" | "PROVIDER_CODEX" | "PROVIDER_GROK"];
  baseUrl?: string;
  apiKey?: SecretRef;
  displayName?: string;
  env?: StoredEnvVar[];
  disabled?: boolean;
  executablePath?: string;
  homePath?: string;
  shadowHomePath?: string;
  launchArgs?: string[];
  ownLogin?: boolean;
}

export const NATIVE_ID = "native";
export const INSTANCE_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export const harnessOf = (provider: Provider): Harness | undefined => (provider === Provider.CLAUDE ? "claude" : provider === Provider.CODEX ? "codex" : provider === Provider.GROK ? "grok" : undefined);
export const providerOf = (harness: string | null | undefined): Provider => (harness === "claude" ? Provider.CLAUDE : harness === "grok" ? Provider.GROK : harness === "codex" ? Provider.CODEX : Provider.UNSPECIFIED);
export const instanceKey = (harness: Harness, id: string): string => `${harness}/${id}`;

export const isRef = (value: unknown): value is SecretRef => typeof value === "object" && value !== null && typeof (value as SecretRef).secretRef === "string";

/** Whether the instance runs on the worker: the worker's own choice, else "all workers". */
export function enabledOn(instance: Pick<InstanceRow, "all_workers">, assignment: Pick<AssignmentRow, "enabled"> | undefined): boolean {
  return assignment?.enabled ?? instance.all_workers;
}

/** Variables of the definition with the worker's added or replaced by name (case-insensitive, like the rules). */
export function mergeEnv(base: readonly StoredEnvVar[], extra: readonly StoredEnvVar[] | undefined): StoredEnvVar[] {
  if (!extra?.length) return [...base];
  const byName = new Map(extra.map((v) => [v.name.toUpperCase(), v]));
  const merged = base.map((v) => byName.get(v.name.toUpperCase()) ?? v);
  const present = new Set(base.map((v) => v.name.toUpperCase()));
  return [...merged, ...extra.filter((v) => !present.has(v.name.toUpperCase()))];
}

/** The profile a worker runs for an instance: the definition with the worker's overrides. */
export function effectiveProfile(instance: InstanceRow, assignment: AssignmentRow | undefined): StoredProfile {
  const o = assignment?.overrides ?? {};
  const runtime = instance.runtime ?? {};
  const endpoint = instance.kind === "endpoint";
  const env = mergeEnv(instance.env ?? [], o.env);
  const apiKey = endpoint ? (o.apiKey ?? instance.api_key ?? undefined) : undefined;
  const launchArgs = o.launchArgs ?? runtime.launchArgs ?? [];
  const pick = (value: string | undefined) => (value ? value : undefined);
  const profile: StoredProfile = {
    id: instance.id,
    kind: endpoint ? "PROVIDER_PROFILE_KIND_CLIPROXYAPI" : "PROVIDER_PROFILE_KIND_NATIVE",
    providers: [instance.harness === "claude" ? "PROVIDER_CLAUDE" : instance.harness === "grok" ? "PROVIDER_GROK" : "PROVIDER_CODEX"],
  };
  const baseUrl = endpoint ? (o.baseUrl ?? instance.base_url) : "";
  if (baseUrl) profile.baseUrl = baseUrl;
  if (apiKey) profile.apiKey = apiKey;
  if (instance.label) profile.displayName = instance.label;
  if (env.length > 0) profile.env = env.map((v) => (v.secret ? { name: v.name, value: v.value, secret: true } : { name: v.name, value: v.value }));
  const executablePath = pick(o.binaryPath ?? runtime.binaryPath);
  const homePath = pick(o.homePath ?? runtime.homePath);
  const shadowHomePath = pick(o.shadowHomePath ?? runtime.shadowHomePath);
  if (executablePath) profile.executablePath = executablePath;
  if (homePath) profile.homePath = homePath;
  if (shadowHomePath) profile.shadowHomePath = shadowHomePath;
  if (launchArgs.length > 0) profile.launchArgs = [...launchArgs];
  if (runtime.ownLogin && !endpoint) profile.ownLogin = true;
  return profile;
}

/**
 * A worker's profiles: every instance enabled on it, merged with its overrides. An instance turned off there is
 * absent, except as a stub without secrets (`disabled`) when the worker would otherwise invent it (the built-in
 * native one) or when threads of the worker use it (they then say why they cannot run).
 */
export function effectiveProfiles(
  instances: readonly InstanceRow[],
  assignments: readonly AssignmentRow[],
  usedOnWorker: ReadonlySet<string>,
): StoredProfile[] {
  const byInstance = new Map(assignments.map((a) => [instanceKey(a.harness, a.instance_id), a]));
  const ordered = [...instances].sort(
    (a, b) => a.harness.localeCompare(b.harness) || Number(b.id === NATIVE_ID) - Number(a.id === NATIVE_ID) || a.id.localeCompare(b.id),
  );
  return ordered.flatMap((instance): StoredProfile[] => {
    const key = instanceKey(instance.harness, instance.id);
    const assignment = byInstance.get(key);
    if (enabledOn(instance, assignment)) return [effectiveProfile(instance, assignment)];
    if (!instance.built_in && !usedOnWorker.has(key)) return [];
    const stub: StoredProfile = {
      id: instance.id,
      kind: instance.kind === "endpoint" ? "PROVIDER_PROFILE_KIND_CLIPROXYAPI" : "PROVIDER_PROFILE_KIND_NATIVE",
      providers: [instance.harness === "claude" ? "PROVIDER_CLAUDE" : instance.harness === "grok" ? "PROVIDER_GROK" : "PROVIDER_CODEX"],
      disabled: true,
    };
    if (instance.label) stub.displayName = instance.label;
    return [stub];
  });
}

/** JSON with object keys sorted: jsonb does not keep key order, so stored and computed documents compare this way. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}

/** Secret ids a set of profiles references. */
export function profileSecretRefs(profiles: readonly StoredProfile[]): string[] {
  return [
    ...new Set(
      profiles.flatMap((p) => [...(isRef(p.apiKey) ? [p.apiKey.secretRef] : []), ...(p.env ?? []).flatMap((v) => (isRef(v.value) ? [v.value.secretRef] : []))]),
    ),
  ];
}

/** An instance's model choices, as pickers apply them. */
export interface InstanceModelsRule {
  readonly harness: Harness;
  readonly id: string;
  readonly favorites: readonly string[];
  readonly hidden: readonly string[];
  readonly shown: readonly string[];
  readonly custom: readonly string[];
}

export const modelsRule = (row: InstanceRow): InstanceModelsRule => ({
  harness: row.harness,
  id: row.id,
  favorites: row.favorites,
  hidden: row.hidden_models,
  shown: row.shown_models,
  custom: row.custom_models,
});

/** A list with the instance's custom models added (not hidden, no effort data); the checks accept them. */
export function withCustomModels(list: ProfileModels, rule: InstanceModelsRule | undefined): ProfileModels {
  const custom = (rule?.custom ?? []).filter((id) => !list.models.some((m) => m.id === id));
  if (custom.length === 0) return list;
  return create(ProfileModelsSchema, { ...list, models: [...list.models, ...custom.map((id) => create(ModelInfoSchema, { id, displayName: id }))] });
}

/**
 * The catalog as pickers see it (docs/worker-config.md, 9.3): per instance, a model is shown when the user showed
 * it, or when the provider does not hide it and the user did not; custom models are added; favorites come first in
 * the user's order. Models are marked hidden, never removed, so a thread on a hidden model still finds its name
 * and efforts. An instance without choices keeps the catalog as the worker sent it.
 */
export function applyInstanceModels(catalog: ui.WorkerModels, rules: readonly InstanceModelsRule[]): ui.WorkerModels {
  if (rules.length === 0) return catalog;
  return create(ui.WorkerModelsSchema, {
    ...catalog,
    profiles: catalog.profiles.map((list) => {
      const harness = harnessOf(list.provider);
      const rule = rules.find((r) => r.harness === harness && r.id === (list.profileId || NATIVE_ID));
      if (!rule) return list;
      const hidden = new Set(rule.hidden);
      const shown = new Set(rule.shown);
      const visible = withCustomModels(list, rule).models.map((m) => ({ ...m, hidden: !(shown.has(m.id) || (!m.hidden && !hidden.has(m.id))) }));
      const favorites = rule.favorites.flatMap((id) => visible.filter((m) => m.id === id));
      const favored = new Set(rule.favorites);
      return create(ProfileModelsSchema, { ...list, models: [...favorites, ...visible.filter((m) => !favored.has(m.id))] });
    }),
  });
}
