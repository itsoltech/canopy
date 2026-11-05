import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { compareClock, nextClock } from "./clock.ts";
import { compactTombstone } from "./merge.ts";
import { emptyRecord, equalValue, saveRecord, type ConfigRow } from "./persistence.ts";
import { DEFAULT_FIELDS, POLICY_FIELDS } from "./project-values.ts";
import { alive } from "./provider-records.ts";
import type { SettingsJson } from "./settings.ts";

const PROJECT_FIELDS = new Set(["name", "kind", "archived", "origin"]);

function managed(kind: string, name: string) {
  if (kind === "project") return PROJECT_FIELDS.has(name);

  if (kind === "project_settings") return DEFAULT_FIELDS.has(name);

  return POLICY_FIELDS.has(name);
}

/** Tracks only supported fields; machine paths and newer fields survive local edits. */
export function projectWriter(
  sql: SqlClient.SqlClient,
  owner: string,
  node: string,
  records: ConfigRow[],
  last: string,
) {
  const state = { last };
  const seen = new Set<ConfigRow>();

  const recordFor = (kind: string, local: string, global: string) => {
    const existing = records.find((r) => r.kind === kind && r.local_id === local);

    if (existing) return existing;
    const row = emptyRecord(kind, global);
    row.local_id = local;
    records.push(row);

    return row;
  };

  const update = (row: ConfigRow, values: SettingsJson, updated: Date) =>
    Effect.gen(function* () {
      seen.add(row);

      if (row.unsupported) return;
      let changed = false;

      for (const name of new Set([...Object.keys(values), ...Object.keys(row.fields)])) {
        if (!(name in values) && !managed(row.kind, name)) continue;
        const value = values[name] ?? null;
        const old = row.fields[name];

        if (old ? equalValue(old.value, value) : value === null) continue;

        const hlc =
          row.revision === "0" && !row.deleted.hlc
            ? `${new Date(updated).getTime()}.0.${node}`
            : nextClock(state.last, node);

        row.fields[name] = { value, hlc, prev: old?.hlc ?? "" };

        if (compareClock(hlc, state.last) > 0) state.last = hlc;
        changed = true;
      }

      if (changed) yield* saveRecord(sql, owner, row, state.last);
    });

  const finish = () =>
    Effect.gen(function* () {
      for (const row of records) {
        if (seen.has(row) || row.unsupported || !alive(row) || row.revision === "0") continue;
        state.last = nextClock(state.last, node);
        row.deleted = { value: true, hlc: state.last, prev: row.deleted.hlc };
        yield* compactTombstone(sql, owner, row, node);
        yield* sql`UPDATE config_history SET state='dismissed' WHERE owner_user_id=${owner}::uuid AND kind=${row.kind}
        AND global_id=${row.global_id} AND reason='deleted' AND notice_node_id=${node} AND state='open'`;
        yield* saveRecord(sql, owner, row, state.last);
      }
    });

  return { recordFor, update, finish };
}
