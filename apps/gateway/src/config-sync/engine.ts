import { type JsonValue } from "@bufbuild/protobuf";
import { computerLink as link } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { ComputerStore } from "../computers/store.ts";
import type { SharedHost } from "../computers/shared.ts";
import { clockParts, compareClock, nextClock } from "./clock.ts";
import { configLock, emptyRecord, maxClock, saveRecord, type ConfigRow } from "./persistence.ts";
import { recordProviders } from "./provider-records.ts";
import { readBatch, receiveItem, syncWorkers, type ReceiveResult } from "./receive.ts";
import { instanceIds } from "./aliases.ts";
import { mapSettingsInstances, settingsValues } from "./settings.ts";
import type { SettingsRow } from "./settings-apply.ts";

export class ConfigSync {
  readonly ahead = new Map<string, number>();
  readonly syncing = new Map<string, boolean>();

  constructor(
    readonly store: ComputerStore,
    readonly host: SharedHost,
    readonly self: () => string,
  ) {}

  /** Seed all existing account preferences, instances and proxies, using their original timestamps. */
  async start() {
    const { store, self } = this;
    await store.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const clock = yield* configLock(sql, store.owner);
        const settings = (yield* sql<SettingsRow>`SELECT * FROM user_settings WHERE user_id=${store.owner}::uuid`)[0];
        const user = (yield* sql<{ created_at: Date }>`SELECT created_at FROM users WHERE id=${store.owner}::uuid`)[0]!;

        const row =
          (yield* sql<ConfigRow>`SELECT * FROM config_items
        WHERE owner_user_id=${store.owner}::uuid AND kind='settings' AND global_id='account'`)[0] ??
          emptyRecord("settings", "account");

        const hlc = `${new Date(settings?.updated_at ?? user.created_at).getTime()}.0.${self()}`;
        let changed = false;

        const peers = yield* sql<{
          node_id: string;
        }>`SELECT node_id FROM computer_peers WHERE owner_user_id=${store.owner}::uuid`;

        const ids = yield* instanceIds(sql, store.owner);

        const values = settingsValues(
          settings?.settings ?? {},
          self(),
          peers.map((p) => p.node_id),
        );

        for (const [name, value] of Object.entries(mapSettingsInstances(values, ids.toGlobal))) {
          if (row.deleted.value === true) break;

          if (row.fields[name]) continue;
          row.fields[name] = { value, hlc, prev: "" };
          changed = true;
        }

        const fieldClock = maxClock(clock.hlc, row.fields);
        const observed = compareClock(row.deleted.hlc, fieldClock) > 0 ? row.deleted.hlc : fieldClock;

        if (changed) yield* saveRecord(sql, store.owner, row, observed);
        else yield* sql`UPDATE config_clock SET hlc=${observed} WHERE owner_user_id=${store.owner}::uuid`;
        yield* recordProviders(sql);
      }).pipe((fx) => Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(fx))),
    );
  }

  /** Batch and cursor commit together; a crash before commit safely replays the batch. */
  async receive(peer: string, update: link.ConfigUpdate, allowed: () => boolean) {
    if (!allowed()) throw new ConnectError("Configuration sharing is off", Code.FailedPrecondition);

    if (update.items.length > 100 || update.checkpoint.length > 100)
      throw new ConnectError("Invalid configuration batch", Code.InvalidArgument);
    const incoming = readBatch(update.items);
    const { store, self, host } = this;

    const result = await store.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const clock = yield* configLock(sql, store.owner);

            const consent = (yield* sql`SELECT node_id FROM computer_peers WHERE owner_user_id=${store.owner}::uuid
          AND node_id=${peer} AND via_node_id IS NULL AND share_config AND peer_share_config FOR SHARE`)[0];

            if (!consent || !allowed())
              return yield* Effect.fail(new ConnectError("Configuration sharing is off", Code.FailedPrecondition));
            const context = { sql, owner: store.owner, key: store.key, self: self(), peer, host };
            const outcome: ReceiveResult = { last: clock.hlc, settings: false, cli: false, providers: false };

            for (const item of incoming) yield* receiveItem(context, item, outcome);
            const workers = outcome.providers ? yield* syncWorkers(sql, store.owner, store.key) : [];
            yield* sql`UPDATE config_clock SET hlc=${outcome.last} WHERE owner_user_id=${store.owner}::uuid`;

            if (update.checkpoint)
              yield* sql`INSERT INTO config_peer_cursors(owner_user_id,node_id,cursor)
          VALUES(${store.owner}::uuid,${peer},${update.checkpoint}) ON CONFLICT(owner_user_id,node_id) DO UPDATE SET cursor=excluded.cursor`;

            return { ...outcome, workers };
          }),
        );
      }),
    );

    const ahead = clockParts(result.last).wall - Date.now();

    if (ahead > 300_000) this.ahead.set(peer, Math.ceil(ahead / 60_000));
    else this.ahead.delete(peer);

    if (result.settings) await host.settingsChanged?.(result.cli);

    if (result.providers) await host.providersChanged?.(result.workers);
  }

  async publishComputer(name: string, neighbors: string[]) {
    const { store, self } = this;
    await store.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const clock = yield* configLock(sql, store.owner);

            const current = (yield* sql<ConfigRow>`SELECT * FROM config_items
          WHERE owner_user_id=${store.owner}::uuid AND kind='computer' AND global_id=${self()}`)[0];

            const row = current ?? emptyRecord("computer", self(), self());
            const values = { name, neighbors: [...neighbors].sort() } satisfies Record<string, JsonValue>;
            let last = clock.hlc;
            let changed = false;

            for (const [key, value] of Object.entries(values)) {
              if (JSON.stringify(row.fields[key]?.value) === JSON.stringify(value)) continue;
              last = nextClock(last, self());
              row.fields[key] = { value, hlc: last, prev: row.fields[key]?.hlc ?? "" };
              changed = true;
            }

            if (changed) yield* saveRecord(sql, store.owner, row, last);
            yield* sql`DELETE FROM config_history WHERE owner_user_id=${store.owner}::uuid AND superseded_at<now()-interval '90 days'`;
          }),
        );
      }),
    );
  }
}
