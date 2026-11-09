import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect, Predicate } from "effect";
import type { SqlClient } from "effect/sql";
import { uuid } from "../agent-environment/composition.ts";
import type { ConfigRow } from "./persistence.ts";
import { NOT_SUPPORTED } from "./provider-apply.ts";
import type { Values } from "./provider-values.ts";
import { isVersion, versionHashes } from "./environment-values.ts";
import { localBlob, presentBlobHashes, verifiedArtifact, type Blobs } from "./environment-blobs.ts";

const options = { ignoreUnknownFields: true };

/** A version this record selects has not arrived yet; the element waits instead of changing to an older one. */
export const WAITING = "Waiting for files from a linked computer";

export type LocalVersion = { version: string; content_hash: string; commit: string };

/** A new library revision, so workers get the change like a local save. */
export function bumpEnvironment(sql: SqlClient.SqlClient, owner: string) {
  return Effect.gen(function* () {
    yield* sql`INSERT INTO agent_environments (owner_user_id) VALUES (${owner}::uuid) ON CONFLICT DO NOTHING`;

    const rows = yield* sql<{ revision: string }>`UPDATE agent_environments SET revision=revision+1
      WHERE owner_user_id=${owner}::uuid RETURNING revision::text`;

    return BigInt(rows[0]!.revision);
  });
}

export function localWorkers(sql: SqlClient.SqlClient, owner: string) {
  return Effect.map(
    sql<{ id: string }>`SELECT id::text FROM workers WHERE owner_user_id=${owner}::uuid
      AND archived_at IS NULL AND revoked_at IS NULL`,
    (rows) => rows.map((r) => create(ui.EnvironmentWorkerSchema, { workerId: r.id })),
  );
}

/** Ids an assignment names: workers of other computers pass through; each computer applies only its own. */
export const named = (...selectors: (ui.EnvironmentSelector | undefined)[]) =>
  new Set(selectors.flatMap((s) => s?.workerIds ?? []).filter(uuid));

export const selectorOf = (value: JsonValue | undefined) =>
  value ? fromJson(ui.EnvironmentSelectorSchema, value, options) : undefined;

export const strings = (value: JsonValue | undefined) =>
  Array.isArray(value) && value.every(Predicate.isString) ? value : undefined;

/** Marks a record this computer keeps but does not apply; false: nothing here changed. */
export const refuse = (row: ConfigRow, reason = NOT_SUPPORTED) => {
  row.unsupported = reason;

  return false;
};

/** Parses or checks received values like a local save; undefined: not valid on this computer. */
export const attempt = <A>(perform: () => A) =>
  Effect.try({ try: perform, catch: () => undefined }).pipe(
    Effect.match({ onFailure: () => undefined, onSuccess: (value) => ({ value }) }),
  );

/** Stores versions this computer lacks, each checked against its hash and checksum, under new local numbers. */
export function storeVersions(
  sql: SqlClient.SqlClient,
  owner: string,
  values: Values,
  local: LocalVersion[],
  blobs: Blobs,
  insert: (json: string, number: bigint, commit: string) => Effect.Effect<unknown, unknown>,
  plugin: boolean,
) {
  return Effect.gen(function* () {
    const installed = new Set(local.map((version) => version.content_hash));

    const pending = versionHashes(values).filter(
      (hash) => isVersion(values[`version.${hash}`]) && !installed.has(hash),
    );

    const available = yield* presentBlobHashes(
      sql,
      owner,
      pending.filter((hash) => !blobs.has(hash)),
    );

    for (const hash of pending) {
      const version = values[`version.${hash}`];

      if (!isVersion(version)) continue;
      const bytes = blobs.get(hash) ?? (available.has(hash) ? yield* localBlob(sql, owner, hash) : undefined);

      if (!bytes) continue;
      const verified = verifiedArtifact(bytes, hash, version.checksum, plugin);

      if (!verified) return false;
      const number = local.reduce((max, l) => (BigInt(l.version) > max ? BigInt(l.version) : max), 0n) + 1n;
      yield* insert(verified.json, number, version.commit);
      local.push({ version: number.toString(), content_hash: hash, commit: version.commit });
    }

    return true;
  });
}
