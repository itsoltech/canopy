import { create, type DescMessage, type MessageInitShape } from "@bufbuild/protobuf";
import { Provider, ProviderProfileKind, ui } from "@canopy/contracts";
import { envListProblems, type ProfileKind } from "@canopy/domain";
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

export const instanceKeyOf = (instance: Pick<ui.ProviderInstance, "harness" | "id">): string =>
  `${Provider[instance.harness]}:${instance.id}`;

export const harnessName = (harness: Provider): string =>
  harness === Provider.CLAUDE ? "Claude" : harness === Provider.GROK ? "Grok" : "Codex";

export const harnessKey = (harness: Provider): ProviderKey => providerKeyOf(harness) ?? "CODEX";

/** The label, else the harness's name for the built-in device login ("Codex", "Claude"), else the id. */
export const instanceName = (instance: Pick<ui.ProviderInstance, "label" | "id" | "builtIn" | "harness">): string =>
  instance.label || (instance.builtIn ? harnessName(instance.harness) : instance.id);

export const kindLabel = (kind: ProviderProfileKind): string =>
  kind === ProviderProfileKind.CLIPROXYAPI ? "Proxy" : "Device login";

export const ruleKind = (kind: ProviderProfileKind): ProfileKind =>
  kind === ProviderProfileKind.CLIPROXYAPI ? "endpoint" : "native";

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Accent colors offered in the forms (shown as a marker in the model picker). */
export const accentColors = [
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#dc2626",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0d9488",
] as const;

// ------------------------------------------------------------------ status

export interface InstanceStatus {
  readonly label: string;
  readonly tone: Tone;
}

/** One line for an instance on a worker, as the list and the detail show it (e.g. "Authenticated · ChatGPT"). */
export function statusOn(on: ui.InstanceOnWorker | undefined, online: boolean): InstanceStatus {
  if (!on) return { label: "Unknown worker", tone: "neutral" };

  if (!on.enabled) return { label: "Turned off", tone: "neutral" };

  if (!on.reported)
    return { label: online ? "Waiting for the worker" : "Applies when the worker connects", tone: "neutral" };

  if (on.available)
    return { label: on.authenticated && on.auth ? `Authenticated · ${on.auth}` : "Available", tone: "emerald" };
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
  const of = `${enabled.length} worker${enabled.length === 1 ? "" : "s"}`;

  if (usable === enabled.length) return { label: `Ready on ${of}`, tone: "emerald" };

  return { label: `${usable}/${enabled.length} workers ready`, tone: usable === 0 ? "rose" : "amber" };
}

/** Versions reported for the instance ("v0.166.0", several when workers differ). */
export function versionsOf(instance: ui.ProviderInstance, workerId: string | undefined): string {
  const versions = new Set(
    instance.workers.filter((w) => (workerId ? w.workerId === workerId : w.enabled) && w.version).map((w) => w.version),
  );

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

export const envRow = (init: Partial<Omit<EnvVarDraft, "key">> = {}): EnvVarDraft => ({
  key: `env-${++rowKey}`,
  name: "",
  value: "",
  secret: false,
  keep: false,
  storedName: "",
  ...init,
});

export const envDrafts = (env: readonly ui.ProfileEnvVarSettings[]): EnvVarDraft[] =>
  env.map((v) =>
    envRow({ name: v.name, value: v.value, secret: v.secret, keep: v.secret, storedName: v.secret ? v.name : "" }),
  );

/** Rows as the gateway takes them: a kept secret goes without its value (the stored one stays). */
export const envInput = (rows: readonly EnvVarDraft[]): MessageInitShape<typeof ui.ProfileEnvVarInputSchema>[] =>
  rows.map((row) => ({
    name: row.name.trim(),
    secret: row.secret,
    ...(!(row.secret && row.keep) && { value: row.value }),
  }));

/** Problems of variable rows, by row key. */
export interface EnvProblems {
  [rowKey: string]: string;
}

/** Problems of variable rows by row key, with the same rules as the gateway and the worker. */
export function envProblems(kind: ProviderProfileKind, rows: readonly EnvVarDraft[]): EnvProblems {
  const problems: EnvProblems = {};

  const shared = new Map(
    envListProblems(
      ruleKind(kind),
      rows.map((row) => ({ name: row.name.trim(), value: row.secret && row.keep ? "" : row.value })),
    ).map(({ index, message }) => [index, message]),
  );

  for (const [index, row] of rows.entries()) {
    const name = row.name.trim();

    const problem =
      shared.get(index) ??
      (row.secret && !row.keep && !row.value ? "Enter the secret value." : undefined) ??
      (row.keep && name !== row.storedName ? "Enter the secret value again to use a different name." : undefined);

    if (problem) problems[row.key] = problem;
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
export const joinArgs = (args: readonly string[]): string =>
  args.map((a) => (a === "" || /[\s"'\\]/.test(a) ? `"${a.replace(/["\\]/g, "\\$&")}"` : a)).join(" ");

// ------------------------------------------------------------------ the definition (global)

export interface InstanceDraft {
  proxyId: string;
  harness: Provider;
  id: string;
  /** The id follows the label until the user edits it (new instances only). */
  idEdited: boolean;
  label: string;
  accentColor: string;
  kind: ProviderProfileKind;
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
    proxyId: "",
    harness,
    id: "",
    idEdited: false,
    label: "",
    accentColor: "",
    kind: ProviderProfileKind.CLIPROXYAPI,
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
    proxyId: instance.proxyId,
    harness: instance.harness,
    id: instance.id,
    idEdited: true,
    label: instance.label,
    accentColor: instance.accentColor,
    kind: instance.kind,
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
  proxyId?: string;
  workers?: string;
  env: EnvProblems;
}

export function draftProblems(
  draft: InstanceDraft,
  options: { builtIn: boolean; creating: boolean; takenIds: ReadonlySet<string> },
): DraftProblems {
  const problems: DraftProblems = { env: envProblems(draft.kind, draft.env) };

  if (!options.builtIn && !draft.label.trim()) problems.label = "Give the instance a label.";

  if (options.creating) {
    const id = draft.id.trim();

    if (!INSTANCE_ID.test(id)) problems.id = "Use lowercase letters, digits, - and _ (start with a letter or digit).";
    else if (id === "native") problems.id = "“native” is the built-in device login.";
    else if (options.takenIds.has(id)) problems.id = `${harnessName(draft.harness)} already has an instance “${id}”.`;

    if (!draft.allWorkers && draft.workerIds.length === 0)
      problems.workers = "Choose at least one worker, or all workers.";
  }

  if (draft.kind === ProviderProfileKind.CLIPROXYAPI) {
    if (!draft.proxyId) problems.proxyId = "Choose a proxy, or add one.";
  }

  return problems;
}

export const hasProblems = (problems: DraftProblems): boolean =>
  Boolean(
    problems.label || problems.id || problems.proxyId || problems.workers || Object.keys(problems.env).length > 0,
  );

export function saveRequest(
  draft: InstanceDraft,
  options: { creating: boolean; expectedRevision: bigint },
): ui.SaveProviderInstanceRequest {
  const endpoint = draft.kind === ProviderProfileKind.CLIPROXYAPI;

  return create(ui.SaveProviderInstanceRequestSchema, {
    harness: draft.harness,
    id: draft.id.trim(),
    create: options.creating,
    label: draft.label.trim(),
    kind: draft.kind,
    proxyId: endpoint ? draft.proxyId : "",
    env: envInput(draft.env),
    runtime: {
      binaryPath: draft.binaryPath.trim(),
      homePath: draft.homePath.trim(),
      shadowHomePath: draft.shadowHomePath.trim(),
      launchArgs: splitArgs(draft.launchArgs),
      ownLogin: draft.ownLogin,
    },
    accentColor: draft.accentColor,
    expectedRevision: options.expectedRevision,
    ...(options.creating && { allWorkers: draft.allWorkers, workerIds: draft.allWorkers ? [] : draft.workerIds }),
  });
}

// ------------------------------------------------------------------ overrides on one worker

/** A field of the worker's overrides: unset follows the definition. */
export interface OverrideDraft {
  proxyId: string;
  binaryPath: string | undefined;
  homePath: string | undefined;
  shadowHomePath: string | undefined;
  launchArgs: string | undefined;
  env: EnvVarDraft[];
}

export function overrideDraftOf(on: ui.InstanceOnWorker | undefined): OverrideDraft {
  const o = on?.overrides;

  return {
    proxyId: o?.proxyId ?? "",
    binaryPath: o?.binaryPath,
    homePath: o?.homePath,
    shadowHomePath: o?.shadowHomePath,
    launchArgs: o?.launchArgsSet ? joinArgs(o.launchArgs) : undefined,
    env: envDrafts(o?.env ?? []),
  };
}

export function overrideRequest(
  instance: ui.ProviderInstance,
  workerId: string,
  draft: OverrideDraft,
): ui.SetInstanceWorkerRequest {
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
      ...(endpoint && { proxyId: draft.proxyId }),
    },
  });
}

export interface OverrideProblems {
  env: EnvProblems;
}

export function overrideProblems(instance: ui.ProviderInstance, draft: OverrideDraft): OverrideProblems {
  return {
    env: envProblems(instance.kind, draft.env),
  };
}

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
  move: [ui.MoveInstanceToProxyRequestSchema, ui.SaveProviderInstanceResponseSchema],
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
  const requestSchema: RequestOf<A> = actions[action][0];
  const responseSchema: ResponseOf<A> = actions[action][1];
  const message = create(requestSchema, request);
  const json = await requestJson("POST", `/api/providers/${action}`, encode(requestSchema, message), timeoutMs);

  return decode(responseSchema, json);
}

export async function listInstances(): Promise<ui.ProviderInstance[]> {
  return decode(ui.ListProviderInstancesResponseSchema, await requestJson("GET", "/api/providers")).instances;
}
