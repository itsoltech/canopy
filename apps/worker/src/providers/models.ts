import type { MessageInitShape } from "@bufbuild/protobuf";
import type { ModelInfo as ClaudeModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { v2 } from "@open-agents/codex-protocol";
import type { ModelInfoSchema } from "@open-agents/contracts";
import { pickDefaultEffort } from "./default-effort.ts";
import type { ResolvedProfile } from "./profiles.ts";

/**
 * Model catalogs (docs/protocol.md#modele-effort-i-steer): what each provider + profile offers, with the
 * reasoning efforts per model. Listed without running a model turn:
 * - Codex: app-server `model/list` (its bundled catalog, the same for every model provider),
 * - Claude: `Query.supportedModels()` of a query that never gets a prompt,
 * - a CLIProxyAPI profile also asks the proxy (`GET /v1/models`): Codex keeps the catalog models the proxy
 *   serves and adds the proxy's other models (no effort data); Claude Code does that itself
 *   (CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).
 * Models that cannot run an agent turn (image, video, speech, embeddings...) are left out (`isAgentModel`), and
 * `default_effort` is the device owner's configured default when the model offers it (default-effort.ts).
 */

export type ModelInit = MessageInitShape<typeof ModelInfoSchema>;

/** Claude Code's effort levels (SDK EffortLevel). */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

export function isClaudeEffort(effort: string): effort is ClaudeEffort {
  return (CLAUDE_EFFORTS as readonly string[]).includes(effort);
}

export function codexModel(model: v2.Model, configuredEffort?: string): ModelInit {
  const efforts = model.supportedReasoningEfforts.map((e) => e.reasoningEffort);
  const defaultEffort = pickDefaultEffort(efforts, configuredEffort, model.defaultReasoningEffort);
  return {
    id: model.model || model.id,
    displayName: model.displayName,
    description: model.description,
    hidden: model.hidden,
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
    displayName: model.displayName,
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
}

/**
 * Words in a model name that mark a model which cannot run an agent turn. Only used when the source reports
 * no output modalities for the model (live, CLIProxyAPI reports none for most image, video and speech models).
 */
const NON_AGENT_WORDS = new Set([
  "image", "images", "imagine", "imagen", "dall", "sora", "veo", "video",
  "tts", "voice", "audio", "speech", "transcribe", "transcription", "whisper", "realtime",
  "embed", "embedding", "embeddings", "moderation", "rerank", "music", "lyria",
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
  return !names.some((name) => name.toLowerCase().split(/[^a-z0-9]+/).some((word) => NON_AGENT_WORDS.has(word)));
}

/**
 * The models a CLIProxyAPI profile serves (OpenAI-style `GET /v1/models`), with the capabilities of its
 * Gemini-style `GET /v1beta/models` (the only listing with modalities; optional, a failure leaves them out).
 */
export async function proxyModels(profile: CliProxyProfile, fetchImpl: typeof fetch = fetch): Promise<ProxyModel[]> {
  const [body, capabilities] = await Promise.all([
    proxyGet(profile, "v1/models", fetchImpl) as Promise<{ data?: { id?: unknown; owned_by?: unknown }[] }>,
    proxyCapabilities(profile, fetchImpl).catch((): ProxyCapabilities[] => []),
  ]);
  const byId = new Map(capabilities.map((c) => [c.id, c]));
  return (body.data ?? []).flatMap((m) => {
    if (typeof m.id !== "string" || !m.id) return [];
    const known = byId.get(m.id);
    return [{ ...known, id: m.id, ownedBy: typeof m.owned_by === "string" ? m.owned_by : "" }];
  });
}

export interface ProxyCapabilities extends ModelCapabilities {
  readonly id: string;
  readonly displayName?: string;
}

/** CLIProxyAPI's Gemini-style `GET /v1beta/models`: per model its display name, output modalities, methods. */
export async function proxyCapabilities(profile: CliProxyProfile, fetchImpl: typeof fetch = fetch): Promise<ProxyCapabilities[]> {
  const body = (await proxyGet(profile, "v1beta/models", fetchImpl)) as {
    models?: { name?: unknown; displayName?: unknown; supportedOutputModalities?: unknown; supportedGenerationMethods?: unknown }[];
  };
  return (body.models ?? []).flatMap((m) => {
    const id = typeof m.name === "string" ? m.name.replace(/^models\//, "") : "";
    if (!id) return [];
    const outputModalities = strings(m.supportedOutputModalities);
    const generationMethods = strings(m.supportedGenerationMethods);
    return [
      {
        id,
        ...(typeof m.displayName === "string" && m.displayName && { displayName: m.displayName }),
        ...(outputModalities && { outputModalities }),
        ...(generationMethods && { generationMethods }),
      },
    ];
  });
}

type CliProxyProfile = Extract<ResolvedProfile, { kind: "cliproxyapi" }>;

async function proxyGet(profile: CliProxyProfile, path: string, fetchImpl: typeof fetch): Promise<unknown> {
  const url = new URL(path, profile.baseUrl.href.endsWith("/") ? profile.baseUrl : new URL(`${profile.baseUrl.href}/`));
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { authorization: `Bearer ${profile.apiKey}` }, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    // Never echo the proxy's address or key (the report reaches the UI).
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`the proxy did not answer GET /${path}: ${message.replaceAll(profile.baseUrl.host, "<proxy>").replaceAll(profile.apiKey, "<key>")}`);
  }
  if (!response.ok) throw new Error(`the proxy answered ${response.status} to GET /${path}`);
  return response.json();
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string") ? (value as string[]) : undefined;
}

/**
 * Codex through a proxy: the catalog models the proxy serves (with their efforts), then the proxy's other
 * agent models (Codex runs them with generic metadata, so no efforts are known). Catalog models are Codex's
 * own agent models and are never filtered.
 */
export function codexProxyModels(catalog: readonly ModelInit[], proxy: readonly ProxyModel[]): ModelInit[] {
  const served = new Set(proxy.map((m) => m.id));
  const known = catalog.filter((m) => served.has(m.id ?? ""));
  const knownIds = new Set(known.map((m) => m.id));
  const extra = proxy
    .filter((m) => !knownIds.has(m.id) && isAgentModel([m.id, m.displayName ?? ""], m))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m): ModelInit => ({ id: m.id, displayName: m.id, description: m.ownedBy ? `CLIProxyAPI (${m.ownedBy})` : "CLIProxyAPI", efforts: [] }));
  // Without the catalog's default the proxy's first model is not a default: Codex would pick its own.
  return [...known, ...extra];
}

/**
 * Claude Code's list without the models that cannot run an agent turn. Through CLIProxyAPI Claude Code lists
 * the proxy's other models under ids of its own (live: `claude-fable-5-dd-<reversed id>`), so the proxy's
 * capabilities are matched by id, alias target or display name.
 */
export function claudeAgentModels(models: readonly ClaudeModelInfo[], capabilities: readonly ProxyCapabilities[] = []): ClaudeModelInfo[] {
  const byName = new Map<string, ProxyCapabilities>();
  for (const c of capabilities) {
    byName.set(c.id.toLowerCase(), c);
    if (c.displayName) byName.set(c.displayName.toLowerCase(), c);
  }
  return models.filter((m) => {
    const names = [m.value, m.resolvedModel ?? "", m.displayName];
    const known = names.map((n) => byName.get(n.toLowerCase())).find((c) => c !== undefined);
    return isAgentModel(names, known);
  });
}
