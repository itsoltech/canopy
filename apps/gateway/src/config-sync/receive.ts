import { computerLink as link } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { type SqlClient } from "effect/sql";
import type { SharedHost } from "./host.ts";
import { instanceReads, instanceSync } from "../store/instance-queries.ts";
import { compareClock } from "./clock.ts";
import { applySettings } from "./settings-apply.ts";
import { supportedComputer } from "./group.ts";
import { place } from "./identity.ts";
import { incomingSecrets, mergeRecord, readItem } from "./merge.ts";
import { maxClock, saveRecord, type ConfigRow } from "./persistence.ts";
import { applyInstance, applyProxy, applyWaiting, NOT_SUPPORTED } from "./provider-apply.ts";
import { PROVIDER_KINDS } from "./provider-values.ts";
import { cipherOf, encryptIncoming, pruneSecrets, recordCiphers, storeSecret } from "./secrets.ts";
import { PROJECT_KINDS } from "./project-values.ts";
import { applyProject, applyProjectConfiguration } from "./project-apply.ts";
import { ENVIRONMENT_KINDS } from "./environment-values.ts";
import { applyEnvironment } from "./environment-apply.ts";

/** Kinds this computer materializes, with their schema version. Everything else is kept and passed on. */
export const SCHEMAS = {
  settings: 1,
  computer: 1,
  proxy: 1,
  instance: 1,
  project: 1,
  project_settings: 1,
  worktree_policy: 1,
  instruction: 1,
  skill: 1,
  marketplace: 1,
  plugin: 1,
} as const;

const ORDER = [
  "computer",
  "proxy",
  "instance",
  "project",
  "project_settings",
  "worktree_policy",
  "instruction",
  "skill",
  "marketplace",
  "plugin",
];

const rank = (kind: string) => (ORDER.includes(kind) ? ORDER.indexOf(kind) : ORDER.length);

export type Received = { row: ConfigRow; plain: Map<string, string> };

/** Decoded batch; proxies come before the instances that point at them. */
export function readBatch(items: readonly link.ConfigItem[]): Received[] {
  return items
    .map((item) => ({ row: readItem(item), plain: incomingSecrets(item) }))
    .sort((a, b) => rank(a.row.kind) - rank(b.row.kind));
}

export type ReceiveContext = {
  sql: SqlClient.SqlClient;
  owner: string;
  key: Buffer;
  self: string;
  peer: string;
  host: SharedHost;
};

export type ReceiveResult = {
  last: string;
  settings: boolean;
  cli: boolean;
  providers: boolean;
  projects?: boolean;
  environment?: boolean;
};

export function checkItem(item: ConfigRow, self: string) {
  if (item.kind === "settings" && (item.global_id !== "account" || item.home_node_id))
    return Effect.fail(new ConnectError("Invalid account configuration", Code.PermissionDenied));

  if (item.kind === "computer" && (!item.home_node_id || item.global_id !== item.home_node_id))
    return Effect.fail(new ConnectError("Invalid configuration computer", Code.PermissionDenied));

  if (
    (PROVIDER_KINDS.has(item.kind) || PROJECT_KINDS.has(item.kind) || ENVIRONMENT_KINDS.has(item.kind)) &&
    item.home_node_id
  )
    return Effect.fail(new ConnectError("Invalid shared configuration", Code.PermissionDenied));

  return Effect.succeed(!(item.kind === "computer" && item.home_node_id === self));
}

function supported(row: ConfigRow) {
  const version = new Map<string, number>(Object.entries(SCHEMAS)).get(row.kind);

  return version === row.schema_version && (row.kind !== "computer" || supportedComputer(row)) ? "" : NOT_SUPPORTED;
}

/** Materializes a merged record through this computer's own rules. */
export function applyRecord(ctx: ReceiveContext, row: ConfigRow, result: ReceiveResult) {
  return Effect.gen(function* () {
    row.unsupported = supported(row);

    if (row.unsupported) return;

    if (row.kind === "settings") {
      result.cli = (yield* applySettings(ctx.sql, ctx.owner, row, ctx.self, ctx.host)) || result.cli;
      result.settings = true;
    } else if (row.kind === "proxy") {
      yield* applyProxy(ctx.sql, ctx.owner, ctx.key, row);
      result.providers = true;
    } else if (row.kind === "instance") {
      yield* applyInstance(ctx.sql, ctx.owner, row);
      result.providers = true;
    } else if (row.kind === "project") {
      yield* applyProject(ctx.sql, ctx.owner, row);
      result.projects = true;
    } else if (row.kind === "project_settings" || row.kind === "worktree_policy") {
      yield* applyProjectConfiguration(ctx.sql, ctx.owner, row, ctx.host);
      result.projects = true;
    } else if (ENVIRONMENT_KINDS.has(row.kind))
      // Content this computer lacks is fetched after the batch commits (ConfigSync.fetchMissing).
      result.environment = (yield* applyEnvironment(ctx.sql, ctx.owner, row)) || !!result.environment;
  });
}

/** One received record: placed (aliases, identity), merged per field, its new secrets stored with our key. */
export function receiveItem(ctx: ReceiveContext, received: Received, result: ReceiveResult) {
  return Effect.gen(function* () {
    const { sql, owner, key, peer } = ctx;

    if (!(yield* checkItem(received.row, ctx.self))) return;
    const placed = yield* place(sql, owner, key, received.row, received.plain);
    const incoming = encryptIncoming(key, placed.item, received.plain);

    const known = placed.current
      ? yield* recordCiphers(sql, owner, placed.item.kind, placed.item.global_id)
      : new Map();

    const cipher = cipherOf(new Map([...known, ...incoming]));
    const { row, changed } = yield* mergeRecord(sql, owner, placed.current, placed.item, peer, cipher);

    if (!placed.current && row.kind === "instance") row.local_id = row.global_id.slice(row.global_id.indexOf(":") + 1);
    result.last = maxClock(result.last, received.row.fields);

    if (compareClock(received.row.deleted.hlc, result.last) > 0) result.last = received.row.deleted.hlc;

    if (placed.republish) yield* saveRecord(sql, owner, placed.republish, result.last);

    if (!changed && !placed.moved) return;

    for (const [name, field] of Object.entries(row.fields)) {
      const ciphertext = incoming.get(`${name}\x1f${field.hlc}`);

      if (ciphertext) yield* storeSecret(sql, owner, row, name, field.hlc, ciphertext);
    }

    yield* applyRecord(ctx, row, result);
    yield* pruneSecrets(sql, owner, row);
    yield* saveRecord(sql, owner, row, result.last);
  });
}

/** Workers of this computer get the changed instances; the records already hold the values. */
export function syncWorkers(sql: SqlClient.SqlClient, owner: string, key: Buffer) {
  return Effect.gen(function* () {
    yield* applyWaiting(sql, owner);

    return yield* instanceSync(sql, instanceReads(sql), key).sync(owner);
  });
}
