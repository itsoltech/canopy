import { create, type DescMethod, type JsonValue, type Message } from "@bufbuild/protobuf";

import { ConnectError } from "@connectrpc/connect";

import { Predicate, Schema } from "effect";

import { ui } from "@canopy/contracts";

import { createHash } from "node:crypto";

import { canonicalJson } from "../store/instance-config.ts";

import { type RemoteServe } from "./remote.ts";

/**
 * Stage 4 of docs/linked-computers.md: configuration the user marked "Share with linked computers".
 * Values live in their own tables (provider_instances, user_settings, projects); this keeps the sharing
 * state, a version vector per item and what every linked computer confirmed. A computer pushes the items
 * a peer does not have yet; the peer applies them with its own handlers, or records a conflict when both
 * changed the same item without seeing each other's change. Secret values cross the link only for shared
 * items and only when the peer lacks them, and are stored again with the receiver's key.
 */

export type Clock = Record<string, number>;

export type Row = {
  item_key: string;
  shared: boolean;
  clock: Clock;
  digest: string;
  changed_by: string;
  changed_at: Date;
  tokens: Record<string, string>;
  note: string;
};

export type Payload = Record<string, JsonValue>;

export const payloadObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson));

export const envValues = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      name: Schema.String,
      value: Schema.optionalKey(Schema.String),
      secret: Schema.optionalKey(Schema.Boolean),
      token: Schema.optionalKey(Schema.String),
    }),
  ),
);

/** A local value: canonical payload, secret tokens by local secret id, and the reverse. */
export type Value = { payload: Payload; tokens: Record<string, string>; refs: Map<string, string>; empty: boolean };

export type ConflictRow = {
  item_key: string;
  node_id: string;
  local_payload: Payload | null;
  remote_payload: Payload;
  remote_secrets: Uint8Array | null;
  remote_clock: Clock;
  remote_digest: string;
  remote_changed_at: Date;
  detected_at: Date;
};

export type Outcome = {
  outcome: "applied" | "same" | "newer" | "conflict" | "unshared" | "rejected" | "secrets";
  message?: string;
};

/** What the link runtime provides: this computer's own handlers and the connected peers. */
export type SharedHost = {
  /** This computer's GatewayService handlers: validation, worker configuration and live UI updates. */
  serve: RemoteServe;
  /** A project with the shared id (projects are one identity on every computer). */
  createProject(id: string, name: string): Promise<void>;
  /** Badges and conflicts changed (OverviewUpdate.shared_config). */
  publish(snapshot: ui.SharedConfigSnapshot): void;
};

export type Peers = {
  self(): string;
  /** Peers connected now with the capability on both sides. */
  ready(): string[];
  /** Linked computers without the capability (older Canopy). */
  outdated(): Promise<string[]>;
  call(nodeId: string, method: DescMethod, request: Message, signal: AbortSignal): AsyncIterable<Message>;
};

export const PUSH_TIMEOUT_MS = 15_000;

export const ORDER = new Map(Object.entries({ instance: 0, models: 1, settings: 2, project: 3 }));

export const SETTINGS_LABEL = new Map(
  Object.entries({
    appearance: "Appearance",
    thread_defaults: "Thread defaults",
    timezone: "Time zone",
    text_generation: "Text generation",
  }),
);

export const HARNESS_LABEL = new Map(Object.entries({ claude: "Claude", codex: "Codex", grok: "Grok" }));

export const digestOf = (payload: Payload) => createHash("sha256").update(canonicalJson(payload)).digest("hex");

export const merge = (a: Clock, b: Clock) => {
  const out = { ...a };

  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v);

  return out;
};

export const bump = (clock: Clock, node: string) => ({ ...clock, [node]: (clock[node] ?? 0) + 1 });

export function compare(a: Clock, b: Clock): "equal" | "before" | "after" | "concurrent" {
  let less = false;
  let more = false;

  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((a[k] ?? 0) < (b[k] ?? 0)) less = true;

    if ((a[k] ?? 0) > (b[k] ?? 0)) more = true;
  }

  return less && more ? "concurrent" : less ? "before" : more ? "after" : "equal";
}

export const wireClock = (clock: Clock) => Object.fromEntries(Object.entries(clock).map(([k, v]) => [k, BigInt(v)]));

export const fromWire = (clock: Record<string, bigint>): Clock =>
  Object.fromEntries(Object.entries(clock).map(([k, v]) => [k, Number(v)]));

export const failure = (cause: unknown): Outcome => ({
  outcome: "rejected",
  message: cause instanceof ConnectError ? cause.rawMessage : "could not apply it here",
});

/** Secret tokens a payload refers to. */
export function tokensIn(payload: Payload): string[] {
  const env = Array.isArray(payload["env"]) ? envValues(payload["env"]) : [];

  return [
    ...(Predicate.isString(payload["apiKey"]) ? [payload["apiKey"]] : []),
    ...env.flatMap((v) => (v.token ? [v.token] : [])),
  ];
}

// ------------------------------------------------------------------ conflict details

export const ENUM_FIELDS = new Set(["colorScheme", "accent", "chatWidth", "provider", "permissionMode"]);

export const ENUM_PREFIX = /^(COLOR_SCHEME|ACCENT_THEME|CHAT_WIDTH|PROVIDER|PERMISSION_MODE)_/;

export const FIELD = new Map(
  Object.entries({
    label: "Name",
    kind: "Connects with",
    baseUrl: "Endpoint",
    accentColor: "Accent",
    apiKey: "API key",
    env: "Variables",
    favorites: "Favourites",
    hidden: "Hidden models",
    shown: "Shown models",
    custom: "Custom models",
    colorScheme: "Color scheme",
    accent: "Accent",
    chatWidth: "Chat width",
    provider: "Provider",
    providerProfileId: "Instance",
    profileId: "Instance",
    permissionMode: "Permissions",
    models: "Models",
    timezone: "Time zone",
    model: "Model",
    effort: "Effort",
    threadTitleInstructions: "Title instructions",
    name: "Name",
  }),
);

export function show(field: string, value: JsonValue | undefined, other?: JsonValue): string {
  // `other` is only given for the other computer's side: its key differs from this computer's.
  if (field === "apiKey") return value ? (other && other !== value ? "A different key" : "Set") : "Not set";

  if (value === undefined || value === null || value === "") return ENUM_FIELDS.has(field) ? "Default" : "Not set";

  if (field === "kind") return value === "endpoint" ? "Endpoint and API key" : "Device login";

  if (Predicate.isString(value) && ENUM_PREFIX.test(value)) {
    const words = value.replace(ENUM_PREFIX, "").toLowerCase().replaceAll("_", " ");

    return words[0]!.toUpperCase() + words.slice(1);
  }

  if (Predicate.isString(value)) return value;

  if (Array.isArray(value)) {
    if (!value.length) return "None";

    return value
      .map((v) =>
        !Predicate.isObjectOrArray(v)
          ? String(v)
          : "secret" in v
            ? `${String(v["name"])} (secret)`
            : "name" in v
              ? `${String(v["name"])}=${String(v["value"] ?? "")}`
              : `${show("provider", "provider" in v ? v["provider"] : undefined, undefined)}: ${String("model" in v ? (v["model"] ?? "") : "")}`,
      )
      .join(", ");
  }

  return Predicate.isObjectOrArray(value) ? canonicalJson(value) : String(value);
}

/** The fields that differ, readable. Secret values never appear; only whether a key is set or another one. */
export function differences(local: Payload | undefined, remote: Payload): ui.SharedConfigField[] {
  const names = [...new Set([...Object.keys(local ?? {}), ...Object.keys(remote)])];

  return names.flatMap((n) =>
    canonicalJson(local?.[n] ?? null) !== canonicalJson(remote[n] ?? null)
      ? [
          create(ui.SharedConfigFieldSchema, {
            name: FIELD.get(n) ?? n,
            local: local ? show(n, local[n]) : "Not on this computer",
            remote: show(n, remote[n], local?.[n]),
          }),
        ]
      : [],
  );
}

export const sharedState: unique symbol = Symbol("SharedConfig state");

export class SharedConfigState {
  rows = new Map<string, Row>();

  queue: Promise<unknown> = Promise.resolve();

  pushing = new Set<string>();

  again = new Set<string>();

  publishTimer: ReturnType<typeof setTimeout> | undefined;
}
