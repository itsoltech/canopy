import { Provider, type ProfileModels } from "@canopy/contracts";
import type { BotModel, ModelInput, ModelReply, ToolCall } from "./types.ts";

type Endpoint = { url: string; key: string };
const argumentsOf = (raw: unknown): Record<string, unknown> => {
  const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid model tool arguments");
  return value as Record<string, unknown>;
};

/** Claude Code model aliases: names the harness resolves, which the Messages API does not accept. */
const HARNESS_ALIAS = /^(default|best|opus|sonnet|haiku|fable|opusplan)(\[1m\])?$/i;

/**
 * The model id a bot sends to the provider API. Bots call the API directly, so a harness alias from a
 * worker's catalog (`default`, `opus`, …) becomes the concrete model it resolves to there. Custom models of
 * the instance pass as they are; without any catalog the id is trusted (the endpoint has the final word).
 * Returns a problem for the user instead when the id cannot work.
 */
export function apiModel(model: string, catalogs: readonly ProfileModels[], custom: readonly string[] = []): { model: string } | { problem: string } {
  if (!model) return { problem: "Choose a model for this bot" };
  if (custom.includes(model)) return { model };
  const listed = catalogs.flatMap((c) => c.models);
  const resolved = listed.find((m) => m.id === model && m.resolvedModel && m.resolvedModel !== model)?.resolvedModel;
  if (resolved) return { model: resolved };
  if (HARNESS_ALIAS.test(model)) return { problem: `"${model}" is a Claude Code alias, not a model of the provider API; choose a concrete model` };
  const known = listed.some((m) => m.id === model || m.resolvedModel === model);
  const complete = catalogs.some((c) => !c.detail && c.models.length > 0);
  if (!known && complete) return { problem: `This provider instance does not offer the model "${model}"` };
  return { model };
}

/** Explicit function schemas only. No provider-hosted tools, CLI, shell, browser or local SDK. */
export function directModel(resolve: (input: ModelInput) => Promise<Endpoint>): BotModel {
  return async (input): Promise<ModelReply> => {
    const endpoint = await resolve(input);
    const base = endpoint.url.replace(/\/+$/, "").replace(/\/v1$/, "");
    const claude = input.configuration.provider === Provider.CLAUDE;
    const grok = input.configuration.provider === Provider.GROK;
    const headers = claude
      ? { "content-type": "application/json", "x-api-key": endpoint.key, authorization: `Bearer ${endpoint.key}`, "anthropic-version": "2023-06-01" }
      : { "content-type": "application/json", authorization: `Bearer ${endpoint.key}` };
    const response = await fetch(`${base}/v1/${claude ? "messages" : grok ? "chat/completions" : "responses"}`, {
      method: "POST", headers, signal: input.signal, redirect: "error",
      body: JSON.stringify(claude ? anthropicRequest(input) : grok ? grokRequest(input) : openaiRequest(input)),
    });
    // Provider errors can echo credentials or input; persist only the status.
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Model endpoint returned HTTP ${response.status}`); }
    const data = await response.json() as Record<string, unknown>;
    return claude ? anthropicReply(data) : grok ? grokReply(data) : openaiReply(data);
  };
}

export function grokRequest(input: ModelInput) {
  return { model: input.configuration.model, stream: false, max_tokens: 4096,
    messages: [{ role: "system", content: input.instructions }, ...input.messages.map((m) => m.role === "tool"
      ? { role: "tool", tool_call_id: m.callId, content: m.text }
      : { role: m.role, content: m.text || null, ...(m.calls?.length && { tool_calls: m.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }) })],
    tools: input.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
    ...(input.configuration.effort && { reasoning_effort: input.configuration.effort }),
  };
}
function grokReply(data: Record<string, unknown>): ModelReply {
  const choices = data["choices"] as { finish_reason?: string; message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[] | undefined;
  const choice = choices?.[0];
  if (!choice?.message || !["stop", "tool_calls"].includes(choice.finish_reason ?? "")) throw new Error("Model returned an incomplete response");
  return { text: choice.message.content ?? "", calls: (choice.message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: argumentsOf(c.function.arguments) })) };
}

export function anthropicRequest(input: ModelInput) {
  const messages = input.messages.map((m) => {
    if (m.role === "tool") return { role: "user", content: [{ type: "tool_result", tool_use_id: m.callId, content: m.text }] };
    return { role: m.role, content: [
      ...(m.text ? [{ type: "text", text: m.text }] : []),
      ...(m.calls ?? []).map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.arguments })),
    ] };
  });
  return { model: input.configuration.model, max_tokens: 4096, system: input.instructions, messages,
    tools: input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    ...(input.configuration.effort && { output_config: { effort: input.configuration.effort } }),
  };
}
export function openaiRequest(input: ModelInput) {
  const items: unknown[] = [];
  for (const m of input.messages) {
    if (m.role === "tool") items.push({ type: "function_call_output", call_id: m.callId, output: m.text });
    else {
      if (m.text) items.push({ role: m.role, content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.text }] });
      for (const c of m.calls ?? []) items.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.arguments) });
    }
  }
  return { model: input.configuration.model, instructions: input.instructions, input: items, store: false,
    tools: input.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false })),
    ...(input.configuration.effort && { reasoning: { effort: input.configuration.effort } }),
  };
}
function anthropicReply(data: Record<string, unknown>): ModelReply {
  const content = data["content"];
  if (!Array.isArray(content) || data["stop_reason"] === "max_tokens") throw new Error("Model returned an incomplete response");
  const calls: ToolCall[] = [];
  const text: string[] = [];
  for (const block of content as Record<string, unknown>[]) {
    if (block["type"] === "text" && typeof block["text"] === "string") text.push(block["text"]);
    if (block["type"] === "tool_use" && typeof block["id"] === "string" && typeof block["name"] === "string") calls.push({ id: block["id"], name: block["name"], arguments: argumentsOf(block["input"]) });
  }
  return { text: text.join("\n"), calls };
}
function openaiReply(data: Record<string, unknown>): ModelReply {
  const output = data["output"];
  if (!Array.isArray(output) || (data["status"] && data["status"] !== "completed")) throw new Error("Model returned an incomplete response");
  const calls: ToolCall[] = [];
  const text: string[] = [];
  for (const block of output as Record<string, unknown>[]) {
    if (block["type"] === "function_call" && typeof block["call_id"] === "string" && typeof block["name"] === "string") calls.push({ id: block["call_id"], name: block["name"], arguments: argumentsOf(block["arguments"]) });
    if (block["type"] === "message" && Array.isArray(block["content"])) for (const part of block["content"] as Record<string, unknown>[]) {
      if (part["type"] === "output_text" && typeof part["text"] === "string") text.push(part["text"]);
    }
  }
  return { text: text.join("\n"), calls };
}
