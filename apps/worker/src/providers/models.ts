import type { MessageInitShape } from "@bufbuild/protobuf";
import type { ModelInfo as ClaudeModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { v2 } from "@open-agents/codex-protocol";
import type { ModelInfoSchema } from "@open-agents/contracts";
import type { ResolvedProfile } from "./profiles.ts";

/**
 * Model catalogs (docs/protocol.md#modele-effort-i-steer): what each provider + profile offers, with the
 * reasoning efforts per model. Listed without running a model turn:
 * - Codex: app-server `model/list` (its bundled catalog, the same for every model provider),
 * - Claude: `Query.supportedModels()` of a query that never gets a prompt,
 * - a CLIProxyAPI profile also asks the proxy (`GET /v1/models`): Codex keeps the catalog models the proxy
 *   serves and adds the proxy's other models (no effort data); Claude Code does that itself
 *   (CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).
 */

export type ModelInit = MessageInitShape<typeof ModelInfoSchema>;

/** Claude Code's effort levels (SDK EffortLevel). */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

export function isClaudeEffort(effort: string): effort is ClaudeEffort {
  return (CLAUDE_EFFORTS as readonly string[]).includes(effort);
}

export function codexModel(model: v2.Model): ModelInit {
  return {
    id: model.model || model.id,
    displayName: model.displayName,
    description: model.description,
    hidden: model.hidden,
    isDefault: model.isDefault,
    efforts: model.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    defaultEffort: model.defaultReasoningEffort,
  };
}

export function claudeModel(model: ClaudeModelInfo): ModelInit {
  return {
    id: model.value,
    ...(model.resolvedModel && model.resolvedModel !== model.value && { resolvedModel: model.resolvedModel }),
    displayName: model.displayName,
    description: model.description,
    // The "default" row is what Claude Code runs when no model is chosen.
    isDefault: model.value === "default",
    efforts: model.supportsEffort === false ? [] : [...(model.supportedEffortLevels ?? [])],
  };
}

export interface ProxyModel {
  readonly id: string;
  readonly ownedBy: string;
}

/** The models a CLIProxyAPI profile serves (OpenAI-style `GET /v1/models`). */
export async function proxyModels(profile: Extract<ResolvedProfile, { kind: "cliproxyapi" }>, fetchImpl: typeof fetch = fetch): Promise<ProxyModel[]> {
  const url = new URL("v1/models", profile.baseUrl.href.endsWith("/") ? profile.baseUrl : new URL(`${profile.baseUrl.href}/`));
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { authorization: `Bearer ${profile.apiKey}` }, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    // Never echo the proxy's address or key (the report reaches the UI).
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`the proxy did not answer GET /v1/models: ${message.replaceAll(profile.baseUrl.host, "<proxy>").replaceAll(profile.apiKey, "<key>")}`);
  }
  if (!response.ok) throw new Error(`the proxy answered ${response.status} to GET /v1/models`);
  const body = (await response.json()) as { data?: { id?: unknown; owned_by?: unknown }[] };
  return (body.data ?? []).flatMap((m) => (typeof m.id === "string" && m.id ? [{ id: m.id, ownedBy: typeof m.owned_by === "string" ? m.owned_by : "" }] : []));
}

/**
 * Codex through a proxy: the catalog models the proxy serves (with their efforts), then the proxy's other
 * models (Codex runs them with generic metadata, so no efforts are known).
 */
export function codexProxyModels(catalog: readonly ModelInit[], proxy: readonly ProxyModel[]): ModelInit[] {
  const served = new Set(proxy.map((m) => m.id));
  const known = catalog.filter((m) => served.has(m.id ?? ""));
  const knownIds = new Set(known.map((m) => m.id));
  const extra = proxy
    .filter((m) => !knownIds.has(m.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m): ModelInit => ({ id: m.id, displayName: m.id, description: m.ownedBy ? `CLIProxyAPI (${m.ownedBy})` : "CLIProxyAPI", efforts: [] }));
  // Without the catalog's default the proxy's first model is not a default: Codex would pick its own.
  return [...known, ...extra];
}
