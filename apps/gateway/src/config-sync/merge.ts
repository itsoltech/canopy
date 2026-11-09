import { create } from "@bufbuild/protobuf";
import { computerLink as link } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect, Schema } from "effect";
import { type SqlClient } from "effect/sql";
import { clockParts, compareClock } from "./clock.ts";
import { emptyRecord, equalValue, type ConfigRow, type Field } from "./persistence.ts";
import { versionKey, type Cipher } from "./secrets.ts";
import { DEVICE_SETTINGS_FIELDS } from "./settings.ts";

export const jsonValue = Schema.decodeUnknownSync(Schema.MutableJson);

/** Secret values ride only on the link stream, keyed by version (see secrets.ts). */
export function wireItem(row: ConfigRow, secrets: ReadonlyMap<string, string> = new Map()): link.ConfigItem {
  const field = (value: Field, name = "deleted") => {
    const secret = secrets.get(versionKey(row.kind, row.global_id, name, value.hlc));

    return create(link.ConfigFieldSchema, {
      valueJson: JSON.stringify(value.value),
      hlc: value.hlc,
      prev: value.prev,
      ...(secret !== undefined && { secret }),
    });
  };

  return create(link.ConfigItemSchema, {
    kind: row.kind,
    globalId: row.global_id,
    homeNodeId: row.home_node_id,
    identity: row.identity,
    fields: Object.fromEntries(
      Object.entries(row.fields).flatMap(([k, v]) =>
        row.kind === "settings" && DEVICE_SETTINGS_FIELDS.has(k) ? [] : [[k, field(v, k)]],
      ),
    ),
    deleted: field(row.deleted),
    schemaVersion: row.schema_version,
  });
}

function readField(field: link.ConfigField): Field {
  clockParts(field.hlc);
  clockParts(field.prev);

  if (compareClock(field.prev, field.hlc) > 0)
    throw new ConnectError("Invalid configuration ancestry", Code.InvalidArgument);

  if (
    field.valueJson.length > 2_000_000 ||
    (field.secret !== undefined && (!field.secret || field.secret.length > 2_000_000 || field.secret.includes("\0")))
  )
    throw new ConnectError("Unsupported configuration field", Code.InvalidArgument);

  try {
    return { value: jsonValue(JSON.parse(field.valueJson)), hlc: field.hlc, prev: field.prev };
  } catch {
    throw new ConnectError("Invalid configuration value", Code.InvalidArgument);
  }
}

/** Plain secret values of a received item by field name; kept apart from the record. */
export const incomingSecrets = (item: link.ConfigItem) =>
  new Map(Object.entries(item.fields).flatMap(([name, f]) => (f.secret === undefined ? [] : [[name, f.secret]])));

export function readItem(item: link.ConfigItem): ConfigRow {
  if (
    !/^[a-z][a-z_]{0,63}$/.test(item.kind) ||
    !item.globalId ||
    item.globalId.length > 200 ||
    item.identity.length > 1000 ||
    (item.homeNodeId !== "" && !/^[a-f0-9]{64}$/.test(item.homeNodeId)) ||
    Object.keys(item.fields).length > 1000 ||
    !item.schemaVersion
  )
    throw new ConnectError("Invalid configuration item", Code.InvalidArgument);
  const row = emptyRecord(item.kind, item.globalId, item.homeNodeId);
  row.identity = item.identity;
  row.schema_version = item.schemaVersion;
  row.deleted = item.deleted ? readField(item.deleted) : row.deleted;

  if (row.deleted.value !== false && row.deleted.value !== true)
    throw new ConnectError("Invalid configuration deletion", Code.InvalidArgument);

  for (const [name, field] of Object.entries(item.fields)) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_.]{0,199}$/.test(name) ||
      name.split(".").some((p) => ["__proto__", "constructor", "prototype"].includes(p))
    )
      throw new ConnectError("Invalid configuration field", Code.InvalidArgument);
    row.fields[name] = readField(field);

    if (!row.fields[name]!.hlc || name === "deleted")
      throw new ConnectError("Invalid configuration field clock", Code.InvalidArgument);
  }

  return row;
}

export function remember(
  sql: SqlClient.SqlClient,
  owner: string,
  row: ConfigRow,
  name: string,
  value: Field,
  noticeNode: string,
  reason = "concurrent",
  cipher?: Cipher,
) {
  const ciphertext = cipher?.(name, value) ?? null;

  return sql`INSERT INTO config_history(owner_user_id,kind,global_id,field,value,hlc,node_id,notice_node_id,reason,secret,ciphertext)
    VALUES(${owner}::uuid,${row.kind},${row.global_id},${name},${JSON.stringify(value.value)}::jsonb,${value.hlc},
      ${clockParts(value.hlc).node},${noticeNode},${reason},${ciphertext !== null},${ciphertext}) ON CONFLICT DO NOTHING`;
}

export function compactTombstone(
  sql: SqlClient.SqlClient,
  owner: string,
  row: ConfigRow,
  peer: string,
  cipher?: Cipher,
) {
  return Effect.gen(function* () {
    let changed = false;

    if (row.deleted.value !== true) return changed;

    for (const [name, field] of Object.entries(row.fields)) {
      if (compareClock(field.hlc, row.deleted.hlc) > 0) continue;
      yield* remember(sql, owner, row, name, field, peer, "deleted", cipher);
      delete row.fields[name];
      changed = true;
    }

    return changed;
  });
}

/** LWW join; history and notices are local, durable and idempotent. */
export function mergeRecord(
  sql: SqlClient.SqlClient,
  owner: string,
  current: ConfigRow | undefined,
  incoming: ConfigRow,
  peer: string,
  cipher?: Cipher,
  same = (_name: string, a: Field, b: Field) => equalValue(a.value, b.value),
) {
  return Effect.gen(function* () {
    const row = current
      ? structuredClone(current)
      : emptyRecord(incoming.kind, incoming.global_id, incoming.home_node_id);

    if (!current) row.identity = incoming.identity;
    row.schema_version = Math.max(row.schema_version, incoming.schema_version);
    let changed = !current || row.schema_version !== current.schema_version;

    for (const [name, next] of Object.entries({ ...incoming.fields, deleted: incoming.deleted })) {
      if (name !== "deleted" && row.deleted.value === true && compareClock(next.hlc, row.deleted.hlc) <= 0) {
        yield* remember(sql, owner, row, name, next, peer, "deleted", cipher);
        continue;
      }

      const old = name === "deleted" ? row.deleted : row.fields[name];
      const order = old ? compareClock(next.hlc, old.hlc) : 1;

      if (old && order === 0 && !equalValue(old.value, next.value))
        return yield* Effect.fail(new ConnectError("Configuration clock reused for a different value", Code.DataLoss));

      if (old && old.hlc && next.hlc && !same(name, old, next)) {
        if (order > 0 && compareClock(next.prev, old.hlc) < 0)
          yield* remember(sql, owner, row, name, old, peer, next.prev ? "concurrent" : "merged", cipher);
        else if (order < 0 && compareClock(old.prev, next.hlc) < 0)
          yield* remember(sql, owner, row, name, next, peer, next.prev ? "concurrent" : "merged", cipher);
      }

      if (order > 0) {
        if (name === "deleted") row.deleted = next;
        else row.fields[name] = next;
        changed = true;
      }
    }

    if (row.deleted.value === true) {
      changed = (yield* compactTombstone(sql, owner, row, peer, cipher)) || changed;

      if (
        Object.keys(row.fields).length &&
        (!current || !Object.keys(current.fields).length || incoming.deleted.hlc !== current.deleted.hlc)
      )
        yield* remember(sql, owner, row, "deleted", row.deleted, peer, "resurrected");
    }

    return { row, changed };
  });
}
