import { create, type DescMessage, type MessageInitShape } from "@bufbuild/protobuf";
import { Provider, ProviderProfileKind, ui, type ModelInfo } from "@open-agents/contracts";
import { envNameProblem, type ProfileKind } from "@open-agents/domain";
import { providerKeyOf, type ProviderKey } from "#lib/features/threads/providers.ts";
import { requestJson } from "#lib/shared/http.ts";
import type { Tone } from "#lib/shared/ui/tone.ts";
import { decode, encode } from "#lib/shared/wire.ts";

/**
 * Global provider instances in the settings (docs/worker-config.md, section 9): an instance is a harness (Claude
 * Code, Codex) and an id, defined once in the gateway and turned on per worker, with per-worker overrides. This
 * module holds the forms' state and its conversion to requests, the status line of an instance on a worker, and the
 * BFF calls. Secrets never come back from the gateway: the forms know only that they are set, and send a value only
 * when the user typed a new one.
 */

export const instanceKeyOf = (instance: Pick<ui.ProviderInstance, "harness" | "id">): string => `${Provider[instance.harness]}:${instance.id}`;
export const harnessName = (harness: Provider): string => (harness === Provider.CLAUDE ? "Claude" : "Codex");
export const harnessKey = (harness: Provider): ProviderKey => providerKeyOf(harness) ?? "CODEX";
export const instanceName = (instance: Pick<ui.ProviderInstance, "label" | "id" | "builtIn" | "harness">): string =>
  instance.label || (instance.builtIn ? `${harnessName(instance.harness)} · device login` : instance.id);
export const kindLabel = (kind: ProviderProfileKind): string => (kind === ProviderProfileKind.CLIPROXYAPI ? "API endpoint" : "Device login");
export const ruleKind = (kind: ProviderProfileKind): ProfileKind => (kind === ProviderProfileKind.CLIPROXYAPI ? "endpoint" : "native");
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Accent colors offered in the forms (shown as a marker in the model picker). */
export const accentColors = ["#2563eb", "#7c3aed", "#db2777", "#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#0d9488"] as const;

// ------------------------------------------------------------------ status

export interface InstanceStatus {
  readonly label: string;
  readonly tone: Tone;
}

/** One line for an instance on a worker, as the list and the detail show it (T3: "Authenticated · ChatGPT"). */
export function statusOn(on: ui.InstanceOnWorker | undefined, online: boolean): InstanceStatus {
  if (!on) return { label: "Unknown worker", tone: "neutral" };
  if (!on.enabled) return { label: "Turned off", tone: "neutral" };
  if (!on.reported) return { label: online ? "Waiting for the worker" : "Applies when the worker connects", tone: "neutral" };
  if (on.available) return { label: on.authenticated && on.auth ? `Authenticated · ${on.auth}` : "Available", tone: "emerald" };
  const detail = on.detail.toLowerCase();
  if (detail.includes("not found") || detail.includes("not runnable")) return { label: "Not installed", tone: "rose" };
  if (detail.includes("api_key")) return { label: "Missing key", tone: "amber" };
  if (detail.includes("not signed in") || detail.includes("login")) return { label: "Not signed in", tone: "amber" };
  if (detail === "disabled") return { label: "Turned off", tone: "neutral" };
  return { label: capitalize(on.detail || "Unavailable"), tone: "rose" };
}

/** In "All workers": how many workers run it, and how many of those report it usable. */
export function statusAcross(instance: ui.ProviderInstance): InstanceStatus {
  const enabled = instance.workers.filter((w) => w.enabled);
  if (enabled.length === 0) return { label: "Not on any worker", tone: "neutral" };
  const usable = enabled.filter((w) => w.available).length;
  const of = instance.allWorkers ? "all workers" : `${enabled.length} worker${enabled.length === 1 ? "" : "s"}`;
  if (usable === enabled.length) return { label: `Available on ${of}`, tone: "emerald" };
  return { label: `Available on ${usable} of ${of}`, tone: usable === 0 ? "rose" : "amber" };
}

/** Versions reported for the instance ("v0.166.0", several when workers differ). */
export function versionsOf(instance: ui.ProviderInstance, workerId: string | undefined): string {
  const versions = new Set(instance.workers.filter((w) => (workerId ? w.workerId === workerId : w.enabled) && w.version).map((w) => w.version));
  return [...versions].map((v) => `v${v}`).join(", ");
}

// ------------------------------------------------------------------ variables

/** One variable row of a form. A kept secret has `value` empty and `keep` set until the user replaces it. */
export interface EnvVarDraft {
  readonly key: string;
  name: string;
  value: string;
  secret: boolean;
  /** An existing secret left as it is (its value never reaches the browser). */
  keep: boolean;
  /** Name of the secret the gateway stores for this row ("" = none); kept by that name. */
  storedName: string;
}

/** "keep" the stored key, "replace" it with a new one, or "clear" it. */
export type KeyAction = "keep" | "replace" | "clear";

let rowKey = 0;
export const envRow = (init: Partial<Omit<EnvVarDraft, "key">> = {}): EnvVarDraft => ({ key: `env-${++rowKey}`, name: "", value: "", secret: false, keep: false, storedName: "", ...init });

export const envDrafts = (env: readonly ui.ProfileEnvVarSettings[]): EnvVarDraft[] =>
  env.map((v) => envRow({ name: v.name, value: v.value, secret: v.secret, keep: v.secret, storedName: v.secret ? v.name : "" }));

/** Rows as the gateway takes them: a kept secret goes without its value (the stored one stays). */
export const envInput = (rows: readonly EnvVarDraft[]): MessageInitShape<typeof ui.ProfileEnvVarInputSchema>[] =>
  rows.map((row) => ({ name: row.name.trim(), secret: row.secret, ...(!(row.secret && row.keep) && { value: row.value }) }));

/** Problems of variable rows by row key, with the same rules as the gateway and the worker. */
export function envProblems(kind: ProviderProfileKind, rows: readonly EnvVarDraft[]): Record<string, string> {
  const problems: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    const problem =
      envNameProblem(ruleKind(kind), name) ??
      (seen.has(name.toUpperCase()) ? `${name} is listed twice.` : undefined) ??
      (row.secret && !row.keep && !row.value ? "Enter the secret value." : undefined) ??
      (row.keep && name !== row.storedName ? "Enter the value again to rename a secret." : undefined);
    seen.add(name.toUpperCase());
    if (problem) problems[row.key] = problem.endsWith(".") ? problem : `${capitalize(problem)}.`;
  }
  return problems;
}

/** Launch arguments typed on one line: split on spaces, quotes keep spaces ("-c" "model=\"x y\""). */
export function splitArgs(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (ch === "\\" && quote === '"' && i + 1 < text.length) current += text[++i];
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

/** The inverse of splitArgs for showing stored arguments. */
export const joinArgs = (args: readonly string[]): string => args.map((a) => (a === "" || /[\s"'\\]/.test(a) ? `"${a.replace(/["\\]/g, "\\$&")}"` : a)).join(" ");

export function urlProblem(value: string): string | undefined {
  const url = URL.canParse(value.trim()) ? new URL(value.trim()) : undefined;
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return "Enter an http(s) URL, e.g. http://127.0.0.1:8317.";
  if (url.username || url.password) return "Put the key in the API key field, not in the URL.";
  return undefined;
}

// ------------------------------------------------------------------ the definition (global)

export interface InstanceDraft {
  harness: Provider;
  id: string;
  /** The id follows the label until the user edits it (new instances only). */
  idEdited: boolean;
  label: string;
  accentColor: string;
  kind: ProviderProfileKind;
  baseUrl: string;
  apiKeySet: boolean;
  keyAction: KeyAction;
  apiKey: string;
  env: EnvVarDraft[];
  binaryPath: string;
  homePath: string;
  shadowHomePath: string;
  launchArgs: string;
  ownLogin: boolean;
  /** New instances: where they run. */
  allWorkers: boolean;
  workerIds: string[];
}

export function newDraft(harness: Provider, workerIds: string[]): InstanceDraft {
  return {
    harness,
    id: "",
    idEdited: false,
    label: "",
    accentColor: "",
    kind: ProviderProfileKind.CLIPROXYAPI,
    baseUrl: "",
    apiKeySet: false,
    keyAction: "replace",
    apiKey: "",
    env: [],
    binaryPath: "",
    homePath: "",
    shadowHomePath: "",
    launchArgs: "",
    ownLogin: false,
    allWorkers: workerIds.length === 0,
    workerIds,
  };
}

export function draftOf(instance: ui.ProviderInstance): InstanceDraft {
  return {
    harness: instance.harness,
    id: instance.id,
    idEdited: true,
    label: instance.label,
    accentColor: instance.accentColor,
    kind: instance.kind,
    baseUrl: instance.baseUrl,
    apiKeySet: instance.apiKeySet,
    keyAction: instance.apiKeySet ? "keep" : "replace",
    apiKey: "",
    env: envDrafts(instance.env),
    binaryPath: instance.runtime?.binaryPath ?? "",
    homePath: instance.runtime?.homePath ?? "",
    shadowHomePath: instance.runtime?.shadowHomePath ?? "",
    launchArgs: joinArgs(instance.runtime?.launchArgs ?? []),
    ownLogin: instance.runtime?.ownLogin ?? false,
    allWorkers: instance.allWorkers,
    workerIds: instance.workers.filter((w) => w.enabled).map((w) => w.workerId),
  };
}

/** An id from a label: lowercase letters, digits and dashes. */
export function idFromLabel(label: string): string {
  return label
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|-+$/g, "")
    .slice(0, 40);
}

export const INSTANCE_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export interface DraftProblems {
  label?: string;
  id?: string;
  baseUrl?: string;
  apiKey?: string;
  workers?: string;
  env: Record<string, string>;
}

export function draftProblems(draft: InstanceDraft, options: { builtIn: boolean; creating: boolean; takenIds: ReadonlySet<string> }): DraftProblems {
  const problems: DraftProblems = { env: envProblems(draft.kind, draft.env) };
  if (!options.builtIn && !draft.label.trim()) problems.label = "Give the instance a label.";
  if (options.creating) {
    const id = draft.id.trim();
    if (!INSTANCE_ID.test(id)) problems.id = "Use lowercase letters, digits, - and _ (start with a letter or digit).";
    else if (id === "native") problems.id = "“native” is the built-in device login.";
    else if (options.takenIds.has(id)) problems.id = `${harnessName(draft.harness)} already has an instance “${id}”.`;
    if (!draft.allWorkers && draft.workerIds.length === 0) problems.workers = "Choose at least one worker, or all workers.";
  }
  if (draft.kind === ProviderProfileKind.CLIPROXYAPI) {
    const problem = urlProblem(draft.baseUrl);
    if (problem) problems.baseUrl = problem;
    if (draft.keyAction === "replace" && draft.apiKeySet && !draft.apiKey) problems.apiKey = "Enter the new key, or keep the current one.";
  }
  return problems;
}

export const hasProblems = (problems: DraftProblems): boolean =>
  Boolean(problems.label || problems.id || problems.baseUrl || problems.apiKey || problems.workers || Object.keys(problems.env).length > 0);

export function saveRequest(draft: InstanceDraft, options: { creating: boolean; expectedRevision: bigint }): ui.SaveProviderInstanceRequest {
  const endpoint = draft.kind === ProviderProfileKind.CLIPROXYAPI;
  return create(ui.SaveProviderInstanceRequestSchema, {
    harness: draft.harness,
    id: draft.id.trim(),
    create: options.creating,
    label: draft.label.trim(),
    kind: draft.kind,
    baseUrl: endpoint ? draft.baseUrl.trim() : "",
    // Unset keeps the stored key; "" clears it.
    ...(endpoint && draft.keyAction === "replace" && draft.apiKey && { apiKey: draft.apiKey }),
    ...(endpoint && draft.keyAction === "clear" && { apiKey: "" }),
    env: envInput(draft.env),
    runtime: {
      binaryPath: draft.binaryPath.trim(),
      homePath: draft.homePath.trim(),
      shadowHomePath: draft.shadowHomePath.trim(),
      launchArgs: splitArgs(draft.launchArgs),
      ownLogin: !endpoint && draft.ownLogin,
    },
    accentColor: draft.accentColor,
    expectedRevision: options.expectedRevision,
    ...(options.creating && { allWorkers: draft.allWorkers, workerIds: draft.allWorkers ? [] : draft.workerIds }),
  });
}

// ------------------------------------------------------------------ overrides on one worker

/** A field of the worker's overrides: unset follows the definition. */
export interface OverrideDraft {
  binaryPath: string | undefined;
  homePath: string | undefined;
  shadowHomePath: string | undefined;
  launchArgs: string | undefined;
  baseUrl: string | undefined;
  apiKeySet: boolean;
  keyAction: KeyAction;
  apiKey: string;
  env: EnvVarDraft[];
}

export function overrideDraftOf(on: ui.InstanceOnWorker | undefined): OverrideDraft {
  const o = on?.overrides;
  return {
    binaryPath: o?.binaryPath,
    homePath: o?.homePath,
    shadowHomePath: o?.shadowHomePath,
    launchArgs: o?.launchArgsSet ? joinArgs(o.launchArgs) : undefined,
    baseUrl: o?.baseUrl,
    apiKeySet: o?.apiKeySet ?? false,
    keyAction: o?.apiKeySet ? "keep" : "replace",
    apiKey: "",
    env: envDrafts(o?.env ?? []),
  };
}

export function overrideRequest(instance: ui.ProviderInstance, workerId: string, draft: OverrideDraft): ui.SetInstanceWorkerRequest {
  const endpoint = instance.kind === ProviderProfileKind.CLIPROXYAPI;
  return create(ui.SetInstanceWorkerRequestSchema, {
    harness: instance.harness,
    id: instance.id,
    workerId,
    overrides: {
      ...(draft.binaryPath !== undefined && { binaryPath: draft.binaryPath }),
      ...(draft.homePath !== undefined && { homePath: draft.homePath }),
      ...(draft.shadowHomePath !== undefined && { shadowHomePath: draft.shadowHomePath }),
      launchArgsSet: draft.launchArgs !== undefined,
      launchArgs: draft.launchArgs !== undefined ? splitArgs(draft.launchArgs) : [],
      env: envInput(draft.env),
      ...(endpoint && draft.baseUrl !== undefined && { baseUrl: draft.baseUrl }),
      // Unset keeps the worker's key; "" drops it (the definition's applies); a value replaces it.
      ...(endpoint && draft.keyAction === "replace" && draft.apiKey && { apiKey: draft.apiKey }),
      ...(endpoint && draft.keyAction === "clear" && { apiKey: "" }),
    },
  });
}

export function overrideProblems(instance: ui.ProviderInstance, draft: OverrideDraft): { baseUrl?: string; apiKey?: string; env: Record<string, string> } {
  return {
    env: envProblems(instance.kind, draft.env),
    ...(draft.baseUrl !== undefined && urlProblem(draft.baseUrl) && { baseUrl: urlProblem(draft.baseUrl) }),
    ...(draft.keyAction === "replace" && draft.apiKeySet && !draft.apiKey && { apiKey: "Enter the new key, or keep the current one." }),
  };
}

// ------------------------------------------------------------------ models

export interface ModelRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Capability tags from the catalog: reasoning (efforts), default. */
  readonly tags: readonly string[];
  readonly favorite: boolean;
  readonly hidden: boolean;
  readonly custom: boolean;
  /** The provider hides it by default (e.g. Codex hidden). */
  readonly providerHidden: boolean;
}

/**
 * The instance's models for the settings: the catalog's (as the workers list them, unfiltered) plus custom ones,
 * each with its visibility under the instance's choices; favorites in the user's order first.
 */
export function modelRows(catalog: readonly ModelInfo[], models: ui.InstanceModels | undefined): ModelRow[] {
  const favorites = models?.favorites ?? [];
  const hidden = new Set(models?.hidden ?? []);
  const shown = new Set(models?.shown ?? []);
  const rows: ModelRow[] = [];
  const seen = new Set<string>();
  for (const info of catalog) {
    if (seen.has(info.id)) continue;
    seen.add(info.id);
    rows.push({
      id: info.id,
      name: info.displayName && info.displayName !== info.id ? info.displayName : info.id,
      description: info.description,
      tags: [...(info.efforts.length > 0 ? ["reasoning"] : []), ...(info.isDefault ? ["default"] : [])],
      favorite: favorites.includes(info.id),
      hidden: !(shown.has(info.id) || (!info.hidden && !hidden.has(info.id))),
      custom: false,
      providerHidden: info.hidden,
    });
  }
  for (const id of models?.custom ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, name: id, description: "", tags: ["custom"], favorite: favorites.includes(id), hidden: hidden.has(id), custom: true, providerHidden: false });
  }
  const rank = new Map(favorites.map((id, i) => [id, i]));
  return [...rows.filter((r) => r.favorite).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!), ...rows.filter((r) => !r.favorite)];
}

const lists = (models: ui.InstanceModels | undefined) => ({
  favorites: [...(models?.favorites ?? [])],
  hidden: [...(models?.hidden ?? [])],
  shown: [...(models?.shown ?? [])],
  custom: [...(models?.custom ?? [])],
});

/** The instance's choices with one model shown or hidden (the provider's own hidden flag needs an explicit "shown"). */
export function withVisibility(models: ui.InstanceModels | undefined, row: Pick<ModelRow, "id" | "providerHidden">, visible: boolean): ui.InstanceModels {
  const hidden = new Set(models?.hidden ?? []);
  const shown = new Set(models?.shown ?? []);
  if (visible) {
    hidden.delete(row.id);
    if (row.providerHidden) shown.add(row.id);
  } else {
    shown.delete(row.id);
    hidden.add(row.id);
  }
  return create(ui.InstanceModelsSchema, { ...lists(models), hidden: [...hidden], shown: [...shown] });
}

export function withFavorite(models: ui.InstanceModels | undefined, id: string, favorite: boolean): ui.InstanceModels {
  const favorites = (models?.favorites ?? []).filter((f) => f !== id);
  return create(ui.InstanceModelsSchema, { ...lists(models), favorites: favorite ? [...favorites, id] : favorites });
}

/** A favorite moved one place up (-1) or down (1). */
export function withFavoriteMoved(models: ui.InstanceModels | undefined, id: string, by: -1 | 1): ui.InstanceModels {
  const favorites = [...(models?.favorites ?? [])];
  const from = favorites.indexOf(id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= favorites.length) return create(ui.InstanceModelsSchema, lists(models));
  [favorites[from], favorites[to]] = [favorites[to]!, favorites[from]!];
  return create(ui.InstanceModelsSchema, { ...lists(models), favorites });
}

export function withCustom(models: ui.InstanceModels | undefined, id: string, add: boolean): ui.InstanceModels {
  const custom = (models?.custom ?? []).filter((c) => c !== id);
  const favorites = add ? (models?.favorites ?? []) : (models?.favorites ?? []).filter((f) => f !== id);
  return create(ui.InstanceModelsSchema, { ...lists(models), custom: add ? [...custom, id] : custom, favorites });
}

/** "Hide all" / "Show all" over the given rows. */
export function withAllVisible(models: ui.InstanceModels | undefined, rows: readonly ModelRow[], visible: boolean): ui.InstanceModels {
  return rows.reduce((acc, row) => withVisibility(acc, row, visible), create(ui.InstanceModelsSchema, lists(models)));
}

export const matchesModel = (row: ModelRow, query: string): boolean => {
  const q = query.trim().toLowerCase();
  return !q || `${row.id} ${row.name} ${row.description}`.toLowerCase().includes(q);
};

// ------------------------------------------------------------------ BFF calls

/** POST /api/providers/<action>: request and response messages of each action. */
const actions = {
  save: [ui.SaveProviderInstanceRequestSchema, ui.SaveProviderInstanceResponseSchema],
  delete: [ui.DeleteProviderInstanceRequestSchema, ui.DeleteProviderInstanceResponseSchema],
  workers: [ui.SetInstanceWorkersRequestSchema, ui.SetInstanceWorkersResponseSchema],
  worker: [ui.SetInstanceWorkerRequestSchema, ui.SetInstanceWorkerResponseSchema],
  models: [ui.SetInstanceModelsRequestSchema, ui.SetInstanceModelsResponseSchema],
  refresh: [ui.RefreshProvidersRequestSchema, ui.RefreshProvidersResponseSchema],
  login: [ui.StartProviderLoginRequestSchema, ui.StartProviderLoginResponseSchema],
} as const satisfies Record<string, readonly [DescMessage, DescMessage]>;

export type ProviderAction = keyof typeof actions;
export const providerActions = actions;

type RequestOf<A extends ProviderAction> = (typeof actions)[A][0];
type ResponseOf<A extends ProviderAction> = (typeof actions)[A][1];

export async function providerCall<A extends ProviderAction>(
  action: A,
  request: MessageInitShape<RequestOf<A>>,
  timeoutMs = 30_000,
): Promise<import("@bufbuild/protobuf").MessageShape<ResponseOf<A>>> {
  const [requestSchema, responseSchema] = actions[action];
  const message = create(requestSchema as DescMessage, request as never);
  const json = await requestJson("POST", `/api/providers/${action}`, encode(requestSchema as DescMessage, message), timeoutMs);
  return decode(responseSchema as DescMessage, json) as never;
}

export async function listInstances(): Promise<ui.ProviderInstance[]> {
  return decode(ui.ListProviderInstancesResponseSchema, await requestJson("GET", "/api/providers")).instances;
}
