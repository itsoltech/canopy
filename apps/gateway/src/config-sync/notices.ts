import { create, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect, Predicate } from "effect";
import { SqlClient } from "effect/sql";
import type { ConfigSync } from "./engine.ts";
import { applySettings } from "./settings-apply.ts";
import { nextClock } from "./clock.ts";
import { configLock, saveRecord, type ConfigRow, type Field } from "./persistence.ts";
import { compactTombstone } from "./merge.ts";
import { applyInstance, applyProxy } from "./provider-apply.ts";
import { PROVIDER_KINDS, secretField } from "./provider-values.ts";
import { syncWorkers } from "./receive.ts";
import { applyProject, applyProjectConfiguration } from "./project-apply.ts";
import { PROJECT_KINDS } from "./project-values.ts";
import { ENVIRONMENT_KINDS } from "./environment-values.ts";
import { applyEnvironment } from "./environment-apply.ts";
import { cipherOf, pruneSecrets, recordCiphers, storeSecret } from "./secrets.ts";
import { CONNECTOR_KINDS } from "./connector-values.ts";
import { applyConnector } from "./connector-apply.ts";
import { configEquality } from "./equality.ts";

type HistoryRow = Field & {
  id: string;
  kind: string;
  global_id: string;
  field: string;
  notice_node_id: string;
  superseded_at: Date;
  secret: boolean;
  ciphertext: Uint8Array | null;
  reason: string;
};

type NoticeRow = HistoryRow & {
  node_name: string;
  local_id: string | null;
  item: ConfigRow["fields"] | null;
  current_fields: ConfigRow["fields"] | null;
  current_deleted: Field | null;
};

/** Old releases also stored equal values in history. Reconcile on read, including after restart. */
async function unresolved(sync: ConfigSync, rows: readonly NoticeRow[]) {
  return sync.store.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const same = yield* configEquality(sql, sync.store.owner, sync.store.key);
      const result: NoticeRow[] = [];

      for (const row of rows) {
        const current = row.field === "deleted" ? row.current_deleted : row.current_fields?.[row.field];
        const ciphers = yield* recordCiphers(sql, sync.store.owner, row.kind, row.global_id);

        if (row.ciphertext) ciphers.set(`${row.field}\x1f${row.hlc}`, row.ciphertext);

        if (current && row.reason !== "resurrected" && same(row.kind, row.field, row, current, cipherOf(ciphers))) {
          yield* sql`UPDATE config_history SET state='dismissed' WHERE owner_user_id=${sync.store.owner}::uuid AND id=${row.id}::uuid AND state='open'`;
        } else result.push(row);
      }

      return result;
    }),
  );
}

/** A deleted element is one notice rather than one per lost field. */
const grouped = (r: Pick<HistoryRow, "kind" | "reason">) =>
  (PROVIDER_KINDS.has(r.kind) ||
    PROJECT_KINDS.has(r.kind) ||
    ENVIRONMENT_KINDS.has(r.kind) ||
    CONNECTOR_KINDS.has(r.kind)) &&
  r.reason === "deleted";

const nameOf = (fields: Record<string, { value: JsonValue } | undefined> | null | undefined) => {
  const value = fields?.["label"]?.value ?? fields?.["name"]?.value;

  return Predicate.isString(value) ? value : "";
};

export async function configNotices(sync: ConfigSync) {
  const rows = await sync.store.query<NoticeRow>(
    `SELECT h.*,i.fields AS current_fields,i.deleted AS current_deleted,COALESCE(NULLIF(p.display_name,''),p.name,c.fields->'name'->>'value','Linked computer') AS node_name,
      i.local_id,CASE WHEN h.kind='project_settings' OR (h.kind='worktree_policy' AND h.global_id<>'account') THEN project.fields ELSE i.fields END AS item
    FROM config_history h LEFT JOIN computer_peers p ON p.owner_user_id=h.owner_user_id AND p.node_id=h.notice_node_id
    LEFT JOIN config_items c ON c.owner_user_id=h.owner_user_id AND c.kind='computer' AND c.global_id=h.notice_node_id
    LEFT JOIN config_items i ON i.owner_user_id=h.owner_user_id AND i.kind=h.kind AND i.global_id=h.global_id
    LEFT JOIN config_items project ON project.owner_user_id=h.owner_user_id AND project.kind='project' AND project.global_id=h.global_id
    WHERE h.owner_user_id=$1::uuid AND h.kind NOT IN ('worker','computer') AND h.state='open' AND h.superseded_at>now()-interval '90 days' ORDER BY h.superseded_at DESC`,
    [sync.store.owner],
  );

  const groups = new Map<string, NoticeRow[]>();

  for (const r of await unresolved(sync, rows)) {
    const key = grouped(r) ? `${r.kind}\0${r.global_id}` : r.id;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  return [...groups.values()].map((group) => {
    const r = group[0]!;
    const lost = Object.fromEntries(group.map((g) => [g.field, { value: g.value }]));
    const present = r.item && Object.keys(r.item).length > 0;

    return create(ui.ConfigNoticeSchema, {
      id: r.id,
      kind: r.kind,
      globalId: r.global_id,
      field: grouped(r) ? "deleted" : r.field,
      nodeName: r.node_name,
      changedAtMs: BigInt(new Date(r.superseded_at).getTime()),
      value: grouped(r)
        ? JSON.stringify(nameOf(lost))
        : r.secret || secretField(r.kind, r.field, r.value)
          ? "A different key"
          : JSON.stringify(r.value),
      reason: r.reason,
      localId: present ? (r.local_id ?? "") : "",
      itemName: nameOf(r.item) || nameOf(lost),
    });
  });
}

/** Writes old values as new changes: they reach every computer like any other edit. */
function restore(sync: ConfigSync, row: ConfigRow, history: readonly HistoryRow[], hlc: string) {
  const { store, self, host } = sync;

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    let clock = hlc;

    for (const h of history) {
      if (h.secret && !h.ciphertext)
        return yield* Effect.fail(new ConnectError("Not supported on this computer", Code.FailedPrecondition));
      clock = nextClock(clock, self());
      const previous = h.field === "deleted" ? row.deleted : row.fields[h.field];
      const next = { value: h.value, hlc: clock, prev: previous?.hlc ?? "" };

      if (h.field === "deleted") row.deleted = next;
      else row.fields[h.field] = next;

      if (h.ciphertext) yield* storeSecret(sql, store.owner, row, h.field, clock, h.ciphertext);
    }

    yield* compactTombstone(
      sql,
      store.owner,
      row,
      self(),
      cipherOf(yield* recordCiphers(sql, store.owner, row.kind, row.global_id)),
    );
    let cli = false;
    let environment = false;

    if (row.kind === "settings") cli = yield* applySettings(sql, store.owner, row, self(), host);
    else if (row.kind === "proxy") yield* applyProxy(sql, store.owner, store.key, row);
    else if (row.kind === "instance") yield* applyInstance(sql, store.owner, row);
    else if (row.kind === "project") yield* applyProject(sql, store.owner, row);
    else if (CONNECTOR_KINDS.has(row.kind)) yield* applyConnector(sql, store.owner, store.key, row);
    else if (ENVIRONMENT_KINDS.has(row.kind)) {
      row.unsupported = "";
      environment = yield* applyEnvironment(sql, store.owner, row);
    } else yield* applyProjectConfiguration(sql, store.owner, row, host);

    yield* pruneSecrets(sql, store.owner, row);
    yield* saveRecord(sql, store.owner, row, clock);
    // After the record: the worker sync compares the domain rows with it and must find them equal.
    const workers = PROVIDER_KINDS.has(row.kind) ? yield* syncWorkers(sql, store.owner, store.key) : [];

    return { cli, workers, environment };
  });
}

export async function manageConfigNotice(sync: ConfigSync, id: string, action: string) {
  if (!["restore", "dismiss"].includes(action) || !/^[a-f0-9-]{36}$/.test(id))
    throw new ConnectError("Choose Restore or Dismiss", Code.InvalidArgument);
  const { store, host } = sync;

  const outcome = await store.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const clock = yield* configLock(sql, store.owner);

          const first = (yield* sql<HistoryRow>`SELECT * FROM config_history WHERE id=${id}::uuid
        AND owner_user_id=${store.owner}::uuid AND state='open' AND superseded_at>now()-interval '90 days' FOR UPDATE`)[0];

          if (!first) return yield* Effect.fail(new ConnectError("This notice was already handled", Code.NotFound));

          const history = grouped(first)
            ? yield* sql<HistoryRow>`SELECT * FROM config_history WHERE owner_user_id=${store.owner}::uuid
              AND kind=${first.kind} AND global_id=${first.global_id} AND reason='deleted' AND state='open'
              AND superseded_at>now()-interval '90 days' ORDER BY field FOR UPDATE`
            : [first];

          let result: { cli: boolean; workers: string[]; environment: boolean } | undefined;

          if (action === "restore") {
            const row = (yield* sql<ConfigRow>`SELECT * FROM config_items WHERE owner_user_id=${store.owner}::uuid
          AND kind=${first.kind} AND global_id=${first.global_id}`)[0];

            if (
              !row ||
              !["settings", "instance", "proxy", ...PROJECT_KINDS, ...ENVIRONMENT_KINDS, ...CONNECTOR_KINDS].includes(
                row.kind,
              )
            )
              return yield* Effect.fail(new ConnectError("Not supported on this computer", Code.FailedPrecondition));
            result = yield* restore(sync, row, history, clock.hlc);
          }

          yield* sql`UPDATE config_history SET state=${action === "restore" ? "restored" : "dismissed"}
        WHERE owner_user_id=${store.owner}::uuid AND id=ANY(${history.map((h) => h.id)}::uuid[])`;

          return { kind: first.kind, ...result };
        }),
      );
    }),
  );

  if (outcome.kind === "settings" && action === "restore") await host.settingsChanged?.(outcome.cli ?? false);

  if (outcome.workers) await host.providersChanged?.(outcome.workers);

  if (PROJECT_KINDS.has(outcome.kind) && action === "restore") await host.projectsChanged?.();

  if (outcome.environment) await host.environmentChanged?.();

  if (CONNECTOR_KINDS.has(outcome.kind) && action === "restore") await host.connectorsChanged?.();
}
