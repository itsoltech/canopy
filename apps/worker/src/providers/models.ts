import type { MessageInitShape } from "@bufbuild/protobuf";
import type { ModelInfo as ClaudeModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { v2 } from "@canopy/codex-protocol";
import type { ModelInfoSchema } from "@canopy/contracts";
import type { JsonObject, JsonValue } from "@canopy/domain";
import { decodeJsonObject, isString, jsonObject } from "./json.ts";
import { pickDefaultEffort } from "./default-effort.ts";
import type { ResolvedProfile } from "./profiles.ts";
import { claudeModelName, concreteModelName } from "./model-metadata.ts";

/**
 * Model catalogs (docs/protocol.md#modele-effort-i-steer): what each provider + profile offers, with the
 * reasoning efforts per model. Listed without running a model turn:
 * - Codex: app-server `model/list` (its bundled catalog, the same for every model provider),
 * - Claude: `Query.supportedModels()` of a query that never gets a prompt,
 * - a CLIProxyAPI profile also asks the proxy (`GET /v1/models`): Codex keeps the catalog models the proxy
 *   serves and adds compatible proxy models (no effort data); Claude Code discovers proxy models itself
 *   (CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).
 * Proxy entries are scoped by family and wire protocol (`proxyModelFits`). Models that cannot run an agent
 * turn (image, video, speech, embeddings...) are left out (`isAgentModel`), and
 * `default_effort` is the device owner's configured default when the model offers it (default-effort.ts).
 */

export type ModelInit = MessageInitShape<typeof ModelInfoSchema>;

/** Claude Code's effort levels (SDK EffortLevel). */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

export function isClaudeEffort(effort: string): effort is ClaudeEffort {
  return CLAUDE_EFFORTS.some((level) => level === effort);
}

type CatalogModel = Pick<
  v2.Model,
  | "id"
  | "model"
  | "displayName"
  | "description"
  | "hidden"
  | "isDefault"
  | "supportedReasoningEfforts"
  | "defaultReasoningEffort"
> &
  Partial<Pick<v2.Model, "upgrade" | "upgradeInfo">>;

export function codexModel(model: CatalogModel, configuredEffort?: string): ModelInit {
  const efforts = model.supportedReasoningEfforts.map((e) => e.reasoningEffort);
  const defaultEffort = pickDefaultEffort(efforts, configuredEffort, model.defaultReasoningEffort);

  return {
    id: model.model || model.id,
    displayName: model.displayName,
    description: model.description,
    hidden: model.hidden,
    legacy: model.hidden || Boolean(model.upgrade || model.upgradeInfo),
    isDefault: model.isDefault,
    efforts,
    ...(defaultEffort && { defaultEffort }),
  };
}

/** `configuredEffort`: the device owner's default for this model (Claude Code reports no default of its own). */
export function claudeModel(model: ClaudeModelInfo, configuredEffort?: string): ModelInit {
  const efforts = model.supportsEffort === false ? [] : [...(model.supportedEffortLevels ?? [])];
  const defaultEffort = pickDefaultEffort(efforts, configuredEffort);

  return {
    id: model.value,
    ...(model.resolvedModel && model.resolvedModel !== model.value && { resolvedModel: model.resolvedModel }),
    displayName: claudeModelName(model),
    description: model.description,
    // The "default" row is what Claude Code runs when no model is chosen.
    isDefault: model.value === "default",
    efforts,
    ...(defaultEffort && { defaultEffort }),
  };
}

/** What a model produces, as a source reports it (absent = not reported). */
export interface ModelCapabilities {
  /** e.g. ["text"], ["text", "image"], ["video"]. */
  readonly outputModalities?: readonly string[];
  /** Gemini-style methods, e.g. ["generateContent"], ["embedContent"]. */
  readonly generationMethods?: readonly string[];
}

export interface ProxyModel extends ModelCapabilities {
  readonly id: string;
  readonly ownedBy: string;
  readonly displayName?: string;
  /** Explicit wire protocols, when the proxy reports them. */
  readonly supportedEndpoints?: readonly string[];
}

/**
 * Words in a model name that mark a model which cannot run an agent turn. Only used when the source reports
 * no output modalities for the model (live, CLIProxyAPI reports none for most image, video and speech models).
 */
const NON_AGENT_WORDS = new Set([
  "image",
  "images",
  "imagine",
  "imagen",
  "dall",
  "sora",
  "veo",
  "video",
  "tts",
  "voice",
  "audio",
  "speech",
  "transcribe",
  "transcription",
  "whisper",
  "realtime",
  "embed",
  "embedding",
  "embeddings",
  "moderation",
  "rerank",
  "music",
  "lyria",
]);

/**
 * Whether a model can run an agent turn (text out, tool calls): reported metadata first (text-only output, a
 * content-generation method), else none of its names (id, display name) has a NON_AGENT_WORDS word.
 * Missing effort data does not matter: such chat models stay.
 */
export function isAgentModel(names: readonly string[], capabilities: ModelCapabilities = {}): boolean {
  const methods = capabilities.generationMethods ?? [];

  if (methods.length > 0 && !methods.includes("generateContent")) return false;
  const outputs = capabilities.outputModalities ?? [];

  if (outputs.length > 0) return outputs.every((m) => m.toLowerCase() === "text");

  return !names.some((name) =>
    name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .some((word) => NON_AGENT_WORDS.has(word)),
  );
}

/**
 * The models a CLIProxyAPI profile serves (OpenAI-style `GET /v1/models`), with the capabilities of its
 * Gemini-style `GET /v1beta/models` (the only listing with modalities; optional, a failure leaves them out).
 */
type FetchModels = (url: URL, init: RequestInit) => Promise<Response>;

export async function proxyModels(profile: CliProxyProfile, fetchImpl: FetchModels = fetch): Promise<ProxyModel[]> {
  const [body, capabilities] = await Promise.all([
    proxyGet(profile, "v1/models", fetchImpl),
    proxyCapabilities(profile, fetchImpl).catch((): ProxyCapabilities[] => []),
  ]);

  const byId = new Map(capabilities.map((c) => [c.id, c]));

  return (Array.isArray(body["data"]) ? body["data"] : []).flatMap((value) => {
    const m = jsonObject(value);

    if (!m || !isString(m["id"]) || !m["id"]) return [];
    const known = byId.get(m["id"]);

    const displayName = isString(m["display_name"]) ? m["display_name"] : known?.displayName;
    const supportedEndpoints = strings(m["supported_endpoint_types"]);

    return [
      {
        ...known,
        id: m["id"],
        ownedBy: isString(m["owned_by"]) ? m["owned_by"] : "",
        ...(displayName && { displayName }),
        ...(supportedEndpoints && { supportedEndpoints }),
      },
    ];
  });
}

export interface ProxyCapabilities extends ModelCapabilities {
  readonly id: string;
  readonly displayName?: string;
}

/** CLIProxyAPI's Gemini-style `GET /v1beta/models`: per model its display name, output modalities, methods. */
export async function proxyCapabilities(
  profile: CliProxyProfile,
  fetchImpl: FetchModels = fetch,
): Promise<ProxyCapabilities[]> {
  const body = await proxyGet(profile, "v1beta/models", fetchImpl);

  return (Array.isArray(body["models"]) ? body["models"] : []).flatMap((value) => {
    const m = jsonObject(value);

    if (!m) return [];
    const id = isString(m["name"]) ? m["name"].replace(/^models\//, "") : "";

    if (!id) return [];
    const outputModalities = strings(m["supportedOutputModalities"]);
    const generationMethods = strings(m["supportedGenerationMethods"]);

    return [
      {
        id,
        ...(isString(m["displayName"]) && m["displayName"] && { displayName: m["displayName"] }),
        ...(outputModalities && { outputModalities }),
        ...(generationMethods && { generationMethods }),
      },
    ];
  });
}

type CliProxyProfile = Extract<ResolvedProfile, { kind: "cliproxyapi" }>;

async function proxyGet(profile: CliProxyProfile, path: string, fetchImpl: FetchModels): Promise<JsonObject> {
  const url = new URL(path, profile.baseUrl.href.endsWith("/") ? profile.baseUrl : new URL(`${profile.baseUrl.href}/`));
  let response: Response;

  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${profile.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    // Never echo the proxy's address or key (the report reaches the UI).
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `the proxy did not answer GET /${path}: ${message.replaceAll(profile.baseUrl.host, "<proxy>").replaceAll(profile.apiKey, "<key>")}`,
    );
  }

  if (!response.ok) throw new Error(`the proxy answered ${response.status} to GET /${path}`);

  return decodeJsonObject(await response.json());
}

function strings(value: JsonValue | undefined): string[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.every(isString) ? value : undefined;
}

/**
 * Codex through a proxy: the catalog models the proxy serves (with their efforts), then the proxy's other
 * compatible agent models (Codex runs them with generic metadata, so no efforts are known). Both must fit
 * the harness; explicit proxy protocol metadata also applies to models known by the catalog.
 */
export function codexProxyModels(catalog: readonly ModelInit[], proxy: readonly ProxyModel[]): ModelInit[] {
  const served = new Set(proxy.flatMap((m) => (proxyModelFits("codex", m) ? [m.id] : [])));
  const known = catalog.filter((m) => served.has(m.id ?? ""));
  const knownIds = new Set(known.map((m) => m.id));

  const extra = proxy
    .flatMap((m): ModelInit[] =>
      !knownIds.has(m.id) && proxyModelFits("codex", m)
        ? [
            {
              id: m.id,
              displayName: m.displayName || concreteModelName(m.id),
              efforts: [],
            },
          ]
        : [],
    )
    .sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));

  // Without the catalog's default the proxy's first model is not a default: Codex would pick its own.
  return [...known, ...extra];
}

/**
 * Claude Code's list without the models that cannot run an agent turn. Through CLIProxyAPI Claude Code lists
 * the proxy's other models under ids of its own (live: `claude-fable-5-dd-<reversed id>`), so the proxy's
 * capabilities are matched by id, alias target or display name.
 */
export function claudeAgentModels(
  models: readonly ClaudeModelInfo[],
  capabilities: readonly ProxyModel[] = [],
): ClaudeModelInfo[] {
  const byName = new Map<string, ProxyModel>();

  for (const c of capabilities) {
    byName.set(c.id.toLowerCase(), c);

    if (c.displayName) byName.set(c.displayName.toLowerCase(), c);
  }

  return models.filter((m) => {
    const names = [m.value, m.resolvedModel ?? "", m.displayName];
    const known = names.map((n) => byName.get(n.toLowerCase())).find((c) => c !== undefined);

    if (known) return proxyModelFits("claude", known);

    // Discovery wrappers can start with "claude-" even for another model family.
    if (/^claude-fable-\d+-dd-/i.test(m.value)) return false;

    return isAgentModel(names) && !names.some((name) => /^(?:gpt|o\d|codex|grok|gemini)(?:[-\s.]|$)/i.test(name));
  });
}

/** Family comes from the actual id/name before the upstream account's owner (which may serve several families). */
export function proxyModelFits(harness: "claude" | "codex" | "grok", model: ProxyModel): boolean {
  if (!isAgentModel([model.id, model.displayName ?? ""], model)) return false;
  const names = [model.id, model.displayName ?? ""];

  const family = names.some((name) => /^claude(?:[-\s]|$)/i.test(name))
    ? "anthropic"
    : names.some((name) => /^(?:gpt|o\d|codex)(?:[-\s.]|$)/i.test(name))
      ? "openai"
      : names.some((name) => /^grok(?:[-\s]|$)/i.test(name))
        ? "xai"
        : names.some((name) => /^gemini(?:[-\s]|$)/i.test(name))
          ? "google"
          : model.ownedBy.toLowerCase();

  const endpoints = model.supportedEndpoints?.map((endpoint) => endpoint.toLowerCase());

  if (harness === "claude") {
    return ["anthropic", "claude"].includes(family) && (!endpoints || endpoints.includes("messages"));
  }

  if (harness === "grok") {
    return ["xai", "x-ai", "grok"].includes(family) && (!endpoints || endpoints.includes("chat_completions"));
  }

  if (["anthropic", "claude", "google", "gemini", "antigravity"].includes(family)) return false;

  return endpoints ? endpoints.includes("responses") : ["openai", "codex", "xai", "x-ai", "grok"].includes(family);
}
