import { fromJsonString, toJson, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import { PermissionMode, Provider } from "@canopy/contracts";
import type { JsonObject, JsonValue } from "@canopy/domain";
import { Match, Option, Predicate, Schema } from "effect";
import { Invalid } from "../../store/store.ts";
import type { GatewayCore, GatewayCoreOptions } from "../../core/core.ts";
import { requiredString } from "../store.ts";
import { isJsonArray, isJsonObject } from "../json.ts";
import type { BotTurn, StoredCall, ToolResult, ToolSpec } from "../types.ts";

export type { ToolResult };

export const str = { type: "string" };
export const bool = { type: "boolean" };
export const strings = { type: "array", items: str, maxItems: 200 };
export const providerSchema = { type: "string", enum: ["claude", "codex", "grok"] };
export const permissionSchema = { type: "string", enum: ["ask", "read_only", "accept_edits", "full_auto"] };

export const object = (properties: JsonObject, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export interface ToolContext {
  core: GatewayCore;
  options: GatewayCoreOptions;
  turn: BotTurn;
  call: StoredCall;
  args: JsonObject;
  string(key: string, max?: number): string;
  optional(key: string): string;
  integer(key: string): number | undefined;
  flag(key: string): boolean | undefined;
  list(key: string): string[] | undefined;
  action<A>(run: () => Promise<A>): Promise<A>;
}

export interface PlatformTool {
  spec: ToolSpec;
  phrase(args: JsonObject): string;
  execute(context: ToolContext): Promise<ToolResult>;
  /** Before any approval card: reject malformed calls (the model gets the error, the user no card) and/or word the card. */
  prepare?(context: ToolContext): Promise<{ prompt?: string } | undefined>;
}

export function define(
  name: string,
  description: string,
  parameters: JsonObject,
  phrase: string | PlatformTool["phrase"],
  execute: PlatformTool["execute"],
  access: "read" | "change" | "approval" = "change",
): PlatformTool {
  return {
    spec: {
      name,
      description,
      parameters,
      source: "platform",
      readOnly: access === "read",
      dangerous: access === "approval",
    },
    phrase: Predicate.isString(phrase) ? () => phrase : phrase,
    execute,
  };
}

export function label(value: JsonValue | undefined, fallback: string): string {
  // oxlint-disable-next-line no-control-regex -- strips control characters from a one-line label
  return Predicate.isString(value) && value ? value.replace(/[\r\n\x00-\x1f]/g, " ").slice(0, 80) : fallback;
}

export function provider(value: JsonValue | undefined): Provider {
  return Match.value(value).pipe(
    Match.when("claude", () => Provider.CLAUDE),
    Match.when("codex", () => Provider.CODEX),
    Match.when("grok", () => Provider.GROK),
    Match.orElse(() => {
      throw new Invalid("provider must be claude, codex or grok");
    }),
  );
}

export function permission(value: JsonValue | undefined): PermissionMode {
  return Match.value(value).pipe(
    Match.when("ask", () => PermissionMode.ASK),
    Match.when("read_only", () => PermissionMode.READ_ONLY),
    Match.when("accept_edits", () => PermissionMode.ACCEPT_EDITS),
    Match.when("full_auto", () => PermissionMode.FULL_AUTO),
    Match.orElse(() => {
      throw new Invalid("permission must be ask, read_only, accept_edits or full_auto");
    }),
  );
}

export function json<D extends DescMessage>(schema: D, value: MessageShape<D>): JsonValue {
  return toJson(schema, value);
}

/** The JSON form of a message type whose JSON is an object (no well-known scalar wrappers). */
export function jsonObject<D extends DescMessage>(schema: D, value: MessageShape<D>): JsonObject {
  const encoded = toJson(schema, value);

  return isJsonObject(encoded) ? encoded : {};
}

/** Arguments have passed `validate`; this states their shape for nested objects the accessors do not cover. */
export function decoded<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: JsonValue | undefined,
): S["Type"] {
  return Option.getOrThrowWith(Schema.decodeUnknownOption(schema)(value), () => new Invalid("invalid arguments"));
}

export function message<D extends DescMessage>(schema: D, value: JsonValue | undefined): MessageShape<D> {
  if (!isJsonObject(value)) throw new Invalid("configuration must be an object");

  try {
    return fromJsonString(schema, JSON.stringify(value));
  } catch {
    throw new Invalid(`invalid ${schema.typeName.split(".").at(-1)} configuration; check field names and values`);
  }
}

export function context(core: GatewayCore, options: GatewayCoreOptions, turn: BotTurn, call: StoredCall): ToolContext {
  return {
    core,
    options,
    turn,
    call,
    args: call.arguments,
    string: (key, max) => requiredString(call.arguments, key, max),
    optional: (key) => {
      const value = call.arguments[key];

      return Predicate.isString(value) ? value : "";
    },
    integer: (key) => {
      const value = call.arguments[key];

      return Predicate.isNumber(value) ? value : undefined;
    },
    flag: (key) => {
      const value = call.arguments[key];

      return Predicate.isBoolean(value) ? value : undefined;
    },
    list: (key) => {
      const value = call.arguments[key];

      return isJsonArray(value) ? value.filter(Predicate.isString) : undefined;
    },
    action: (run) => core.botAction(turn, call, run),
  };
}

/** JSON schema `type` keywords the platform tools use for scalars. */
const scalar = (type: JsonValue, value: JsonValue): boolean =>
  Match.value(type).pipe(
    Match.when("string", () => Predicate.isString(value)),
    Match.whenOr("number", "integer", () => Predicate.isNumber(value)),
    Match.when("boolean", () => Predicate.isBoolean(value)),
    Match.orElse(() => false),
  );

/** The model sees a JSON schema; execution validates it too (including unknown fields). */
export function validate(schema: JsonObject, value: JsonValue, path = "arguments"): void {
  const bad = (detail: string): never => {
    throw new Invalid(`${path}: ${detail}`);
  };

  const type = schema["type"];
  const allowed = schema["enum"];

  if (type === "object") {
    if (!isJsonObject(value)) return bad("expected an object");
    const properties = isJsonObject(schema["properties"]) ? schema["properties"] : {};
    const required = schema["required"];

    for (const key of isJsonArray(required) ? required.filter(Predicate.isString) : [])
      if (!Object.hasOwn(value, key)) bad(`${key} is required`);

    for (const [key, v] of Object.entries(value)) {
      const property = Object.hasOwn(properties, key) ? properties[key] : undefined;

      if (!isJsonObject(property)) return bad(`unknown field ${key}`);
      validate(property, v, `${path}.${key}`);
    }
  } else if (type === "array") {
    if (!isJsonArray(value)) return bad("expected an array");
    const items = isJsonObject(schema["items"]) ? schema["items"] : {};

    if (value.length > Number(schema["maxItems"] ?? 1000)) bad("too many entries");

    for (const v of value) validate(items, v, path);
  } else if (type && !scalar(type, value)) bad(`expected ${type}`);

  if (type === "integer" && (!Number.isSafeInteger(value) || Number(value) < Number(schema["minimum"] ?? 0)))
    bad("expected a nonnegative integer");

  if (isJsonArray(allowed) && !allowed.includes(value)) bad(`choose ${allowed.join(", ")}`);

  if (Predicate.isString(value) && value.length > 100_000) bad("value is too long");
}
