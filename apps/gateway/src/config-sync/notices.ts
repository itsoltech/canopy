import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { ConfigSync } from "./engine.ts";
import { applySettings } from "./engine.ts";
import { nextClock } from "./clock.ts";
import { configLock, saveRecord, type ConfigRow, type Field } from "./persistence.ts";
import { compactTombstone } from "./merge.ts";

type HistoryRow = Field & {
  id: string;
  kind: string;
  global_id: string;
  field: string;
  notice_node_id: string;
  superseded_at: Date;
  secret: boolean;
  reason: string;
  node_name: string;
};

export async function configNotices(sync: ConfigSync) {
  const rows = await sync.store.query<HistoryRow>(
    `SELECT h.*,COALESCE(NULLIF(p.display_name,''),p.name,c.fields->'name'->>'value','Linked computer') AS node_name
    FROM config_history h LEFT JOIN computer_peers p ON p.owner_user_id=h.owner_user_id AND p.node_id=h.notice_node_id
    LEFT JOIN config_items c ON c.owner_user_id=h.owner_user_id AND c.kind='computer' AND c.global_id=h.notice_node_id
    WHERE h.owner_user_id=$1::uuid AND h.state='open' AND h.superseded_at>now()-interval '90 days' ORDER BY h.superseded_at DESC`,
    [sync.store.owner],
  );

  return rows.map((r) =>
    create(ui.ConfigNoticeSchema, {
      id: r.id,
      kind: r.kind,
      globalId: r.global_id,
      field: r.field,
      nodeName: r.node_name,
      changedAtMs: BigInt(new Date(r.superseded_at).getTime()),
      value: r.secret ? "A different key" : JSON.stringify(r.value),
      reason: r.reason,
    }),
  );
}

export async function manageConfigNotice(sync: ConfigSync, id: string, action: string) {
  if (!["restore", "dismiss"].includes(action) || !/^[a-f0-9-]{36}$/.test(id))
    throw new ConnectError("Choose Restore or Dismiss", Code.InvalidArgument);
  const { store, self, host } = sync;
  let cliChanged = false;
  await store.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const clock = yield* configLock(sql, store.owner);

          const history = (yield* sql<HistoryRow>`SELECT * FROM config_history WHERE id=${id}::uuid
        AND owner_user_id=${store.owner}::uuid AND state='open' AND superseded_at>now()-interval '90 days' FOR UPDATE`)[0];

          if (!history) return yield* Effect.fail(new ConnectError("This notice was already handled", Code.NotFound));

          if (action === "restore") {
            const row = (yield* sql<ConfigRow>`SELECT * FROM config_items WHERE owner_user_id=${store.owner}::uuid
          AND kind=${history.kind} AND global_id=${history.global_id}`)[0];

            if (!row || history.secret || history.kind !== "settings")
              return yield* Effect.fail(new ConnectError("Not supported on this computer", Code.FailedPrecondition));
            const hlc = nextClock(clock.hlc, self());
            const previous = history.field === "deleted" ? row.deleted : row.fields[history.field];
            const next = { value: history.value, hlc, prev: previous?.hlc ?? "" };

            if (history.field === "deleted") row.deleted = next;
            else row.fields[history.field] = next;
            yield* compactTombstone(sql, store.owner, row, self());
            cliChanged = yield* applySettings(sql, store.owner, row, self(), host);
            yield* saveRecord(sql, store.owner, row, hlc);
          }

          yield* sql`UPDATE config_history SET state=${action === "restore" ? "restored" : "dismissed"}
        WHERE owner_user_id=${store.owner}::uuid AND id=${id}::uuid`;
        }),
      );
    }),
  );

  if (action === "restore") await host.settingsChanged?.(cliChanged);
}
