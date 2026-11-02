import { create } from "@bufbuild/protobuf";
import { Provider, ProviderProfileKind, ui, type ModelInfo } from "@open-agents/contracts";
import { envNameProblem, type ProfileKind } from "@open-agents/domain";
import { requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";

/**
 * Provider profiles in the settings (docs/worker-config.md, "Profile dostawców"): the edit form's state, its
 * conversion to SaveProviderProfileRequest, and the BFF calls. Secrets never come back from the gateway: the form
 * knows only that they are set, and sends a value only when the user typed a new one.
 */

export const profileName = (profile: Pick<ui.ProviderProfileSettings, "displayName" | "id" | "builtIn">): string =>
  profile.displayName || (profile.builtIn ? "Device login" : profile.id);

export const kindLabel = (kind: ProviderProfileKind): string => (kind === ProviderProfileKind.CLIPROXYAPI ? "API endpoint" : "Device login");

export const ruleKind = (kind: ProviderProfileKind): ProfileKind => (kind === ProviderProfileKind.CLIPROXYAPI ? "endpoint" : "native");

/** One variable row of the form. A kept secret has `value` empty and `keep` set until the user replaces it. */
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

/** "keep" the stored key, "replace" it with `apiKey`, or "clear" it. */
export type KeyAction = "keep" | "replace" | "clear";

export interface ProfileDraft {
  profileId: string;
  builtIn: boolean;
  displayName: string;
  kind: ProviderProfileKind;
  claude: boolean;
  codex: boolean;
  baseUrl: string;
  apiKeySet: boolean;
  keyAction: KeyAction;
  apiKey: string;
  env: EnvVarDraft[];
  enabled: boolean;
}

let rowKey = 0;
export const envRow = (init: Partial<Omit<EnvVarDraft, "key">> = {}): EnvVarDraft => ({ key: `env-${++rowKey}`, name: "", value: "", secret: false, keep: false, storedName: "", ...init });

export function draftOf(profile: ui.ProviderProfileSettings | undefined): ProfileDraft {
  if (!profile) {
    return {
      profileId: "",
      builtIn: false,
      displayName: "",
      kind: ProviderProfileKind.CLIPROXYAPI,
      claude: true,
      codex: true,
      baseUrl: "",
      apiKeySet: false,
      keyAction: "replace",
      apiKey: "",
      env: [],
      enabled: true,
    };
  }
  return {
    profileId: profile.id,
    builtIn: profile.builtIn,
    displayName: profile.displayName,
    kind: profile.kind,
    claude: profile.providers.includes(Provider.CLAUDE),
    codex: profile.providers.includes(Provider.CODEX),
    baseUrl: profile.baseUrl,
    apiKeySet: profile.apiKeySet,
    keyAction: profile.apiKeySet ? "keep" : "replace",
    apiKey: "",
    env: profile.env.map((v) => envRow({ name: v.name, value: v.value, secret: v.secret, keep: v.secret, storedName: v.secret ? v.name : "" })),
    enabled: profile.enabled,
  };
}

export interface DraftProblems {
  displayName?: string;
  providers?: string;
  baseUrl?: string;
  apiKey?: string;
  /** By row key. */
  env: Record<string, string>;
}

/** What the gateway would refuse, said next to the field. */
export function draftProblems(draft: ProfileDraft): DraftProblems {
  const problems: DraftProblems = { env: {} };
  if (!draft.builtIn && !draft.displayName.trim()) problems.displayName = "Give the profile a name.";
  if (!draft.builtIn && !draft.claude && !draft.codex) problems.providers = "Choose at least one agent.";
  if (draft.kind === ProviderProfileKind.CLIPROXYAPI) {
    const url = URL.canParse(draft.baseUrl.trim()) ? new URL(draft.baseUrl.trim()) : undefined;
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) problems.baseUrl = "Enter an http(s) URL, e.g. http://127.0.0.1:8317.";
    else if (url.username || url.password) problems.baseUrl = "Put the key in the API key field, not in the URL.";
    if (draft.keyAction === "replace" && draft.apiKeySet && !draft.apiKey) problems.apiKey = "Enter the new key, or keep the current one.";
  }
  const seen = new Set<string>();
  for (const row of draft.env) {
    const name = row.name.trim();
    const problem =
      envNameProblem(ruleKind(draft.kind), name) ??
      (seen.has(name.toUpperCase()) ? `${name} is listed twice.` : undefined) ??
      (row.secret && !row.keep && !row.value ? "Enter the secret value." : undefined) ??
      (row.keep && name !== row.storedName ? "Enter the value again to rename a secret." : undefined);
    seen.add(name.toUpperCase());
    if (problem) problems.env[row.key] = problem.endsWith(".") ? problem : `${capitalize(problem)}.`;
  }
  return problems;
}

export const hasProblems = (problems: DraftProblems): boolean =>
  Boolean(problems.displayName || problems.providers || problems.baseUrl || problems.apiKey || Object.keys(problems.env).length > 0);

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function saveRequest(workerId: string, draft: ProfileDraft, expectedConfigVersion: bigint): ui.SaveProviderProfileRequest {
  const endpoint = draft.kind === ProviderProfileKind.CLIPROXYAPI;
  return create(ui.SaveProviderProfileRequestSchema, {
    workerId,
    profileId: draft.profileId,
    displayName: draft.displayName.trim(),
    kind: draft.kind,
    providers: [...(draft.claude ? [Provider.CLAUDE] : []), ...(draft.codex ? [Provider.CODEX] : [])],
    baseUrl: endpoint ? draft.baseUrl.trim() : "",
    // Unset keeps the stored key; "" clears it.
    ...(endpoint && draft.keyAction === "replace" && draft.apiKey && { apiKey: draft.apiKey }),
    ...(endpoint && draft.keyAction === "clear" && { apiKey: "" }),
    env: draft.env.map((row) => ({
      name: row.name.trim(),
      secret: row.secret,
      // A kept secret goes without its value: the gateway keeps the stored one.
      ...(!(row.secret && row.keep) && { value: row.value }),
    })),
    enabled: draft.enabled,
    expectedConfigVersion,
  });
}

// ------------------------------------------------------------------ model selection

/** The checkboxes' start: the saved selection, else what pickers show now (not hidden by the provider). */
export function initialShown(models: readonly ModelInfo[], selection: ui.ModelSelection | undefined): Set<string> {
  if (!selection) return new Set(models.filter((m) => !m.hidden).map((m) => m.id));
  const shown = new Set(selection.shown);
  const known = new Set(selection.known);
  return new Set(models.filter((m) => shown.has(m.id) || (!known.has(m.id) && selection.showNew)).map((m) => m.id));
}

/** Models that arrived after the selection was saved (pickers show them only with show_new). */
export const newSince = (models: readonly ModelInfo[], selection: ui.ModelSelection | undefined): Set<string> =>
  selection ? new Set(models.filter((m) => !selection.known.includes(m.id)).map((m) => m.id)) : new Set();

export function matchesSearch(model: ModelInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || [model.id, model.displayName, model.description, model.resolvedModel].some((text) => text.toLowerCase().includes(q));
}

// ------------------------------------------------------------------ BFF calls

const base = (workerId: string) => `/api/workers/${encodeURIComponent(workerId)}/profiles`;

export async function saveProfile(request: ui.SaveProviderProfileRequest): Promise<ui.SaveProviderProfileResponse> {
  return decode(ui.SaveProviderProfileResponseSchema, await requestJson("POST", base(request.workerId), encode(ui.SaveProviderProfileRequestSchema, request)));
}

export async function deleteProfile(workerId: string, profileId: string, expectedConfigVersion: bigint): Promise<void> {
  await requestJson("POST", `${base(workerId)}/delete`, encode(ui.DeleteProviderProfileRequestSchema, create(ui.DeleteProviderProfileRequestSchema, { workerId, profileId, expectedConfigVersion })));
}

export async function saveSelection(request: ui.SetModelSelectionRequest): Promise<ui.SetModelSelectionResponse> {
  return decode(ui.SetModelSelectionResponseSchema, await requestJson("PUT", `${base(request.workerId)}/models`, encode(ui.SetModelSelectionRequestSchema, request)));
}

/** Availability as the worker reports it now (live through the overview), over what the page loaded. */
export function withReport(profile: ui.ProviderProfileSettings, worker: ui.Worker | undefined): ui.ProviderProfileSettings {
  const reported = worker?.profiles.find((p) => p.id === profile.id);
  // Only a report of the configuration the page shows (or newer) says something about these settings.
  if (!worker || !reported || worker.appliedVersion < worker.configVersion) return profile;
  return create(ui.ProviderProfileSettingsSchema, { ...profile, available: reported.available, detail: reported.detail });
}

/** The profile turned on or off, everything else as stored (secrets kept). */
export const toggleRequest = (workerId: string, profile: ui.ProviderProfileSettings, configVersion: bigint): ui.SaveProviderProfileRequest =>
  saveRequest(workerId, { ...draftOf(profile), enabled: !profile.enabled }, configVersion);
