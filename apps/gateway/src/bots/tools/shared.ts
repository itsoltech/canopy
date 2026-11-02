import { fromJson, toJson, type DescMessage, type JsonValue, type MessageShape } from "@bufbuild/protobuf";
import { PermissionMode, Provider } from "@open-agents/contracts";
import { Invalid } from "../../store/store.ts";
import type { GatewayCore, GatewayCoreOptions } from "../../core/core.ts";
import { requiredString } from "../store.ts";
import type { BotTurn, StoredCall, ToolSpec } from "../types.ts";

export const str = { type: "string" };
export const bool = { type: "boolean" };
export const strings = { type: "array", items: str, maxItems: 200 };
export const providerSchema = { type: "string", enum: ["claude", "codex"] };
export const permissionSchema = { type: "string", enum: ["ask", "read_only", "accept_edits", "full_auto"] };
export const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
export interface ToolContext {
  core: GatewayCore;
  options: GatewayCoreOptions;
  turn: BotTurn;
  call: StoredCall;
  args: Record<string, unknown>;
  string(key: string, max?: number): string;
  optional(key: string): string;
  action<A>(run: () => Promise<A>): Promise<A>;
}
export interface PlatformTool {
  spec: ToolSpec;
  phrase(args: Record<string, unknown>): string;
  execute(context: ToolContext): Promise<unknown>;
}
export function define(name: string, description: string, parameters: Record<string, unknown>, phrase: string | PlatformTool["phrase"], execute: PlatformTool["execute"], access: "read" | "change" | "approval" = "change"): PlatformTool {
  return { spec: { name, description, parameters, source: "platform", readOnly: access === "read", dangerous: access === "approval" }, phrase: typeof phrase === "string" ? () => phrase : phrase, execute };
}
export function label(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value.replace(/[\r\n\x00-\x1f]/g, " ").slice(0, 80) : fallback;
}
export function provider(value: unknown): Provider {
  if (value !== "claude" && value !== "codex") throw new Invalid("provider must be claude or codex");
  return value === "claude" ? Provider.CLAUDE : Provider.CODEX;
}
export function permission(value: unknown): PermissionMode {
  const modes: Record<string, PermissionMode> = { ask: PermissionMode.ASK, read_only: PermissionMode.READ_ONLY, accept_edits: PermissionMode.ACCEPT_EDITS, full_auto: PermissionMode.FULL_AUTO };
  if (typeof value !== "string" || !modes[value]) throw new Invalid("permission must be ask, read_only, accept_edits or full_auto");
  return modes[value]!;
}
export function json<D extends DescMessage>(schema: D, value: MessageShape<D>): JsonValue { return toJson(schema, value); }
export function message<D extends DescMessage>(schema: D, value: unknown): MessageShape<D> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Invalid("configuration must be an object");
  try { return fromJson(schema, value as JsonValue); }
  catch { throw new Invalid(`invalid ${schema.typeName.split(".").at(-1)} configuration; check field names and values`); }
}
export function context(core: GatewayCore, options: GatewayCoreOptions, turn: BotTurn, call: StoredCall): ToolContext {
  return { core, options, turn, call, args: call.arguments,
    string: (key, max) => requiredString(call.arguments, key, max),
    optional: (key) => typeof call.arguments[key] === "string" ? call.arguments[key] as string : "",
    action: (run) => core.botAction(turn, call, run),
  };
}

/** The model sees a JSON schema; execution validates it too (including unknown fields). */
export function validate(schema: Record<string, unknown>, value: unknown, path = "arguments"): void {
  const bad = (detail: string): never => { throw new Invalid(`${path}: ${detail}`); };
  if (schema["type"] === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) bad("expected an object");
    const record = value as Record<string, unknown>;
    const properties = schema["properties"] as Record<string, Record<string, unknown>>;
    for (const key of (schema["required"] ?? []) as string[]) if (!(key in record)) bad(`${key} is required`);
    for (const [key, v] of Object.entries(record)) {
      if (!properties[key]) bad(`unknown field ${key}`);
      validate(properties[key]!, v, `${path}.${key}`);
    }
  } else if (schema["type"] === "array") {
    if (!Array.isArray(value)) bad("expected an array");
    const values = value as unknown[];
    if (values.length > Number(schema["maxItems"] ?? 1000)) bad("too many entries");
    for (const v of values) validate(schema["items"] as Record<string, unknown>, v, path);
  } else if (schema["type"] && typeof value !== (schema["type"] === "integer" ? "number" : schema["type"])) bad(`expected ${schema["type"]}`);
  if (schema["type"] === "integer" && (!Number.isSafeInteger(value) || Number(value) < Number(schema["minimum"] ?? 0))) bad("expected a nonnegative integer");
  if (Array.isArray(schema["enum"]) && !schema["enum"].includes(value)) bad(`choose ${schema["enum"].join(", ")}`);
  if (typeof value === "string" && value.length > 100_000) bad("value is too long");
}
