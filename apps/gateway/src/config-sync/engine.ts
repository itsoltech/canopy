import { type JsonValue } from "@bufbuild/protobuf";
import { computerLink as link } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect, Result } from "effect";
import { SqlClient } from "effect/sql";
import type { ComputerStore } from "../computers/store.ts";
import type { SharedHost } from "../computers/shared.ts";
import { SettingsStore } from "../store/settings.ts";
import { clockParts, compareClock, nextClock } from "./clock.ts";
import { mergeRecord, readItem } from "./merge.ts";
import { configLock, emptyRecord, maxClock, saveRecord, type ConfigRow } from "./persistence.ts";
import { materializeSettings, settingsRequest, settingsValues, type SettingsJson } from "./settings.ts";
import { supportedComputer } from "./group.ts";

export type SettingsRow = { settings: SettingsJson; version: string; updated_at: Date };

export class ConfigSync {
  readonly ahead = new Map<string, number>();
  readonly syncing = new Map<string, boolean>();

  constructor(
    readonly store: ComputerStore,
    readonly host: SharedHost,
    readonly self: () => string,
  ) {}

  /** Seed all existing account preferences, including defaults, using their original timestamp. */
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

        for (const [name, value] of Object.entries(
          settingsValues(
            settings?.settings ?? {},
            self(),
            peers.map((p) => p.node_id),
          ),
        )) {
          if (row.deleted.value === true) break;

          if (row.fields[name]) continue;
          row.fields[name] = { value, hlc, prev: "" };
          changed = true;
        }

        const fieldClock = maxClock(clock.hlc, row.fields);
        const observed = compareClock(row.deleted.hlc, fieldClock) > 0 ? row.deleted.hlc : fieldClock;

        if (changed) yield* saveRecord(sql, store.owner, row, observed);
        else yield* sql`UPDATE config_clock SET hlc=${observed} WHERE owner_user_id=${store.owner}::uuid`;
      }).pipe((fx) => Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(fx))),
    );
  }

  /** Batch and cursor commit together; a crash before commit safely replays the batch. */
  async receive(peer: string, update: link.ConfigUpdate, allowed: () => boolean) {
    if (!allowed()) throw new ConnectError("Configuration sharing is off", Code.FailedPrecondition);
    const incoming = update.items.map(readItem);

    if (incoming.length > 100 || update.checkpoint.length > 100)
      throw new ConnectError("Invalid configuration batch", Code.InvalidArgument);
    const { store, self, host } = this;
    let settingsChanged = false;
    let cliChanged = false;

    const observed = await store.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const clock = yield* configLock(sql, store.owner);

            const consent = (yield* sql`SELECT node_id FROM computer_peers WHERE owner_user_id=${store.owner}::uuid
          AND node_id=${peer} AND via_node_id IS NULL AND share_config AND peer_share_config FOR SHARE`)[0];

            if (!consent || !allowed())
              return yield* Effect.fail(new ConnectError("Configuration sharing is off", Code.FailedPrecondition));
            let last = clock.hlc;

            for (const item of incoming) {
              if (item.kind === "settings" && (item.global_id !== "account" || item.home_node_id))
                return yield* Effect.fail(new ConnectError("Invalid account configuration", Code.PermissionDenied));

              if (item.kind === "computer" && (!item.home_node_id || item.global_id !== item.home_node_id))
                return yield* Effect.fail(new ConnectError("Invalid configuration computer", Code.PermissionDenied));

              // This computer is authoritative for its own graph declaration; forwarded echoes cannot edit it.
              if (item.kind === "computer" && item.home_node_id === self()) continue;

              const current = (yield* sql<ConfigRow>`SELECT * FROM config_items
            WHERE owner_user_id=${store.owner}::uuid AND kind=${item.kind} AND global_id=${item.global_id}`)[0];

              const { row, changed } = yield* mergeRecord(sql, store.owner, current, item, peer);
              last = maxClock(last, item.fields);

              if (compareClock(item.deleted.hlc, last) > 0) last = item.deleted.hlc;

              if (!changed) continue;
              row.unsupported =
                ["settings", "computer"].includes(row.kind) && row.schema_version === 1
                  ? ""
                  : "Not supported on this computer";

              if (row.kind === "computer" && !supportedComputer(row))
                row.unsupported = "Not supported on this computer";

              if (row.kind === "settings" && !row.unsupported) {
                cliChanged = (yield* applySettings(sql, store.owner, row, self(), host)) || cliChanged;
                settingsChanged = true;
              }

              yield* saveRecord(sql, store.owner, row, last);
            }

            yield* sql`UPDATE config_clock SET hlc=${last} WHERE owner_user_id=${store.owner}::uuid`;

            if (update.checkpoint)
              yield* sql`INSERT INTO config_peer_cursors(owner_user_id,node_id,cursor)
          VALUES(${store.owner}::uuid,${peer},${update.checkpoint}) ON CONFLICT(owner_user_id,node_id) DO UPDATE SET cursor=excluded.cursor`;

            return last;
          }),
        );
      }),
    );

    const ahead = clockParts(observed).wall - Date.now();

    if (ahead > 300_000) this.ahead.set(peer, Math.ceil(ahead / 60_000));
    else this.ahead.delete(peer);

    if (settingsChanged) await host.settingsChanged?.(cliChanged);
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

export function applySettings(sql: SqlClient.SqlClient, owner: string, row: ConfigRow, self: string, host: SharedHost) {
  return Effect.gen(function* () {
    const current = (yield* sql<SettingsRow>`SELECT * FROM user_settings WHERE user_id=${owner}::uuid`)[0];

    const deleted =
      row.deleted.value === true && Object.values(row.fields).every((f) => compareClock(f.hlc, row.deleted.hlc) <= 0);

    const values = deleted
      ? Object.fromEntries(Object.keys(settingsValues(current?.settings ?? {}, self)).map((key) => [key, null]))
      : Object.fromEntries(Object.entries(row.fields).map(([key, field]) => [key, field.value]));

    const parsed = yield* Effect.try(() =>
      settingsRequest(materializeSettings(current?.settings ?? {}, values, self), BigInt(current?.version ?? 0)),
    ).pipe(Effect.result);

    if (Result.isFailure(parsed)) {
      row.unsupported = "Not supported on this computer";

      return false;
    }

    const request = parsed.success;

    const valid = yield* Effect.tryPromise(() => host.validateSettings?.(request) ?? Promise.resolve()).pipe(
      Effect.result,
    );

    if (Result.isFailure(valid)) {
      row.unsupported = "Not supported on this computer";

      return false;
    }

    const settings = yield* SettingsStore;
    yield* settings.updateUser({
      userId: owner,
      synced: true,
      expectedVersion: request.expectedVersion,
      ...(request.appearance && { appearance: request.appearance }),
      ...(request.threadDefaults && { threadDefaults: request.threadDefaults }),
      ...(request.general && { general: request.general }),
      ...(request.composer && { composer: request.composer }),
      ...(request.sidebar && { sidebar: request.sidebar }),
      ...(request.textGeneration && { textGeneration: request.textGeneration }),
      ...(request.cliUpdates && { cliUpdates: request.cliUpdates }),
      timezone: request.timezone ?? "",
    });

    return (
      JSON.stringify(current?.settings["cliUpdates"] ?? {}) !==
      JSON.stringify(request.cliUpdates ? { intervalMinutes: request.cliUpdates.intervalMinutes } : {})
    );
  });
}
