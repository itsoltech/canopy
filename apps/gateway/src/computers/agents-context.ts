import { type JsonObject, type JsonValue } from "@bufbuild/protobuf";
import type { ui } from "@canopy/contracts";

import { Code, ConnectError } from "@connectrpc/connect";

import { DEFAULT_BUS_LIMITS, type JsonValue as ArgumentValue } from "@canopy/domain";

import { qualifyId } from "@canopy/domain/computers";

import { Effect, Predicate, Schema } from "effect";

import type { CoreServices } from "../core/core.ts";

/** Older homes reject this operation instead of running the exchange in their private bot session. */
export const SEND_ISOLATED_BOT_MESSAGE = "send_isolated_bot_message";
export const START_INDEPENDENT_THREAD = "start_thread";

export type Actor = {
  requiresIsolatedBot?: boolean;
  id: string;
  kind: "thread" | "bot";
  hops: number;
  name: string;
  routineId?: string;
  routineTitle?: string;
  sender?: ui.AgentSender;
};

export type Reference = {
  peer_node_id: string;
  call_id: string;
  actor_id: string;
  actor_kind: "thread" | "bot";
  target_id: string;
  target_kind: "thread" | "bot";
  target_turn_id: string;
  hops: number;
  operation: string;
  parent_link: boolean;
  result: JsonValue;
  source_routine_id: string | null;
  source_routine_title: string;
};

export type Scope = {
  run<A, E>(effect: Effect.Effect<A, E, CoreServices>): Promise<A>;
  transaction<A>(run: () => Promise<A>): Promise<A>;
};

export const fail = (message: string): never => {
  throw new ConnectError(message, Code.FailedPrecondition);
};

/** Linked work reserves one step for its reply; deliveries may use the final step. */
export function requireLinkedChainCapacity(hops: number, reserveReply: boolean) {
  if (hops > DEFAULT_BUS_LIMITS.maxHops - (reserveReply ? 1 : 0))
    fail(
      `This automated conversation reached its limit (${DEFAULT_BUS_LIMITS.maxHops} steps). Send a new message to continue.`,
    );
}

export const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export type Arguments = { [key: string]: ArgumentValue };

export const isToolArguments = Schema.is(Schema.Record(Schema.String, Schema.MutableJson));

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const record = (value: JsonValue | undefined): JsonObject =>
  isJsonObject(value) ? value : fail("Invalid linked agent arguments");

export const text = (a: Arguments, key: string, optional = false): string =>
  Predicate.isString(a[key]) && (optional || String(a[key]).trim()) && String(a[key]).length <= 100_000
    ? String(a[key])
    : optional && a[key] === undefined
      ? ""
      : fail(`Invalid ${key}`);

export function qualifyResult(value: JsonValue, node: string, key = ""): JsonValue {
  if (Array.isArray(value)) return value.map((v) => qualifyResult(v, node, key));

  if (Predicate.isObject(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, qualifyResult(v, node, k)]));

  return Predicate.isString(value) && (key === "id" || key.endsWith("_id") || key.endsWith("_ids"))
    ? qualifyId(value, node)
    : value;
}

export const agentsState: unique symbol = Symbol("LinkedAgents state");

export class LinkedAgentsState {
  readonly pendingBotSpawns = new Map<string, Promise<JsonValue>>();
  ticking = false;
}
