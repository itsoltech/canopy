import { type JsonValue } from "@bufbuild/protobuf";
import { Effect, Schema } from "effect";
import { type SqlClient } from "effect/sql";
import { canonicalJson } from "../store/instance-config.ts";
import { compareClock, nextClock } from "./clock.ts";
import { instanceIds } from "./aliases.ts";
import { mapSettingsInstances, settingsValues, type SettingsJson } from "./settings.ts";
import { fieldAncestry } from "./ancestry.ts";

export type Field = { value: JsonValue; hlc: string; prev: string; edited?: boolean; seen?: string[] };

export type Fields = Record<string, Field>;

export type ConfigRow = {
  kind: string;
  global_id: string;
  local_id: string;
  home_node_id: string;
  identity: string;
  fields: Fields;
  deleted: Field;
  revision: string;
  schema_version: number;
  unsupported: string;
};

export type ClockRow = { epoch: string; revision: string; hlc: string };

export const equalValue = (a: JsonValue, b: JsonValue) => canonicalJson(a) === canonicalJson(b);
const stringValue = Schema.is(Schema.String);

/** The clock row serializes commits, including local settings and received batches. */
export function configLock(sql: SqlClient.SqlClient, owner: string) {
  return Effect.gen(function* () {
    yield* sql`INSERT INTO config_clock(owner_user_id) VALUES(${owner}::uuid) ON CONFLICT DO NOTHING`;

    return (yield* sql<ClockRow>`SELECT * FROM config_clock WHERE owner_user_id=${owner}::uuid FOR UPDATE`)[0]!;
  });
}

export function saveRecord(sql: SqlClient.SqlClient, owner: string, row: ConfigRow, hlc: string) {
  return Effect.gen(function* () {
    const clock = (yield* sql<ClockRow>`UPDATE config_clock SET revision=revision+1,hlc=${hlc}
      WHERE owner_user_id=${owner}::uuid RETURNING *`)[0]!;

    yield* sql`INSERT INTO config_items(owner_user_id,kind,global_id,local_id,home_node_id,identity,fields,deleted,revision,schema_version,unsupported)
      VALUES(${owner}::uuid,${row.kind},${row.global_id},${row.local_id},${row.home_node_id},${row.identity},
        ${JSON.stringify(row.fields)}::jsonb,${JSON.stringify(row.deleted)}::jsonb,${clock.revision}::bigint,${row.schema_version},${row.unsupported})
      ON CONFLICT(owner_user_id,kind,global_id) DO UPDATE SET local_id=excluded.local_id,identity=excluded.identity,fields=excluded.fields,deleted=excluded.deleted,
        revision=excluded.revision,schema_version=excluded.schema_version,unsupported=excluded.unsupported`;
  });
}

export function emptyRecord(kind: string, id: string, home = ""): ConfigRow {
  return {
    kind,
    global_id: id,
    local_id: id,
    home_node_id: home,
    identity: "",
    fields: {},
    deleted: { value: false, hlc: "", prev: "" },
    revision: "0",
    schema_version: 1,
    unsupported: "",
  };
}

/** Called inside SettingsStore's transaction, after validation and before commit. */
export function configSettingsChanged(
  sql: SqlClient.SqlClient,
  owner: string,
  before: SettingsJson,
  after: SettingsJson,
) {
  return Effect.gen(function* () {
    const node = (yield* sql<{
      node_id: string;
    }>`SELECT node_id FROM computer_identity WHERE owner_user_id=${owner}::uuid`)[0];

    if (!node) return;
    const clock = yield* configLock(sql, owner);

    const current = (yield* sql<ConfigRow>`SELECT * FROM config_items
      WHERE owner_user_id=${owner}::uuid AND kind='settings' AND global_id='account'`)[0];

    const row = current ?? emptyRecord("settings", "account");

    const peers = yield* sql<{
      node_id: string;
    }>`SELECT node_id FROM computer_peers WHERE owner_user_id=${owner}::uuid`;

    const pins = Object.entries(row.fields)
      .filter(([name]) => name.startsWith("sidebar.pinned"))
      .flatMap(([, field]) =>
        Array.isArray(field.value)
          ? field.value.flatMap((ref) => (stringValue(ref) ? [ref.split("@")[1] ?? ""] : []))
          : [],
      );

    const nodes = [...peers.map((p) => p.node_id), ...pins];
    const ids = yield* instanceIds(sql, owner);
    const previous = mapSettingsInstances(settingsValues(before, node.node_id, nodes), ids.toGlobal);
    const values = mapSettingsInstances(settingsValues(after, node.node_id, nodes), ids.toGlobal);
    let last = clock.hlc;
    let changed = false;

    for (const field of new Set([...Object.keys(previous), ...Object.keys(values)])) {
      const value = values[field] ?? null;

      if (current && equalValue(value, previous[field] ?? null)) continue;
      last = nextClock(last, node.node_id);
      row.fields[field] = { value, hlc: last, ...(yield* fieldAncestry(sql, owner, row, field)), edited: true };
      changed = true;
    }

    if (changed) yield* saveRecord(sql, owner, row, last);
  });
}

export function maxClock(clock: string, fields: Fields) {
  for (const field of Object.values(fields)) if (compareClock(field.hlc, clock) > 0) clock = field.hlc;

  return clock;
}
