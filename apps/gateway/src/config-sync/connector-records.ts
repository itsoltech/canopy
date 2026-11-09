import { randomBytes } from "node:crypto";
import { create, fromJson, toJson } from "@bufbuild/protobuf";
import { ConnectorToolSchema } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { AccountRow } from "../connectors/records.ts";
import { connectorSealing } from "../connectors/sealing.ts";
import { decryptSecret, encryptSecret } from "../store/secrets.ts";
import { compareClock, nextClock } from "./clock.ts";
import { accountIdentity, CONNECTOR_FIELDS, connectorIdentity } from "./connector-values.ts";
import { compactTombstone } from "./merge.ts";
import { configLock, emptyRecord, equalValue, type ConfigRow } from "./persistence.ts";
import { saveRecords } from "./record-batches.ts";
import { alive } from "./provider-records.ts";
import type { Values } from "./provider-values.ts";
import { cipherOf, currentSecret, pruneSecrets, recordCiphers, storeSecret } from "./secrets.ts";

/** Every local shared write locks the clock before accounts, including OAuth refresh transactions. */
export function connectorTransaction<A, E, R>(sql: SqlClient.SqlClient, key: Buffer, effect: Effect.Effect<A, E, R>) {
  return sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SELECT 1 FROM config_clock ORDER BY owner_user_id FOR UPDATE`;
      const result = yield* effect;
      yield* recordConnectors(sql, key);

      return result;
    }),
  );
}

export function recordConnectors(sql: SqlClient.SqlClient, key: Buffer) {
  return Effect.gen(function* () {
    const owners = yield* sql<{ owner_user_id: string; node_id: string }>`SELECT owner_user_id::text,node_id
      FROM computer_identity ORDER BY owner_user_id`;

    for (const { owner_user_id: owner, node_id: node } of owners) yield* recordOwner(sql, key, owner, node);
  });
}

function recordOwner(sql: SqlClient.SqlClient, key: Buffer, owner: string, node: string) {
  return Effect.gen(function* () {
    const clock = yield* configLock(sql, owner);
    const state = { last: clock.hlc };
    const pending = new Set<ConfigRow>();

    const records = [
      ...(yield* sql<ConfigRow>`SELECT * FROM config_items WHERE owner_user_id=${owner}::uuid
      AND kind IN ('connector','oauth_app')`),
    ];

    const seen = new Set<ConfigRow>();
    const sealing = connectorSealing(sql, key);

    const accounts = yield* sql<AccountRow & { updated_at: Date }>`SELECT * FROM connector_accounts
      WHERE owner_user_id=${owner}::uuid ORDER BY id`;

    const apps = yield* sql<{ connector_type: string; credentials: Uint8Array; updated_at: Date }>`SELECT *
      FROM connector_oauth_apps WHERE owner_user_id=${owner}::uuid ORDER BY connector_type`;

    const update = (kind: string, id: string, values: Values, plain: string | null, updated: Date) =>
      Effect.gen(function* () {
        const row = records.find((r) => r.kind === kind && r.local_id === id) ?? emptyRecord(kind, id);
        seen.add(row);

        if (row.unsupported) return;
        let changed = false;
        const current = yield* currentSecret(sql, owner, key, row, "credentials");
        const same = plain !== null && current?.plain === plain;

        for (const name of new Set([...Object.keys(values), ...Object.keys(row.fields), "credentials"])) {
          if (!CONNECTOR_FIELDS.has(name)) continue;
          const old = row.fields[name];

          const value =
            name === "credentials"
              ? plain === null
                ? null
                : same
                  ? (old?.value ?? null)
                  : randomBytes(16).toString("hex")
              : (values[name] ?? null);

          if (old ? equalValue(old.value, value) : value === null) continue;

          const hlc =
            row.revision === "0" && !row.deleted.hlc
              ? `${new Date(updated).getTime()}.0.${node}`
              : nextClock(state.last, node);

          row.fields[name] = { value, hlc, prev: old?.hlc ?? "" };

          if (compareClock(hlc, state.last) > 0) state.last = hlc;

          if (name === "credentials" && plain !== null)
            yield* storeSecret(sql, owner, row, name, hlc, encryptSecret(key, plain));
          changed = true;
        }

        row.identity = connectorIdentity(kind, values);

        if (changed) {
          yield* pruneSecrets(sql, owner, row);
          pending.add(row);
        }
      });

    for (const a of accounts) {
      // Migrate legacy encrypted headers inside the gateway; no plaintext goes into config_items.
      const credentials = a.credentials || Object.keys(a.legacy_headers).length ? yield* sealing.credentials(a) : null;

      yield* update(
        "connector",
        a.id,
        {
          type: a.connector_type,
          name: a.name,
          url: a.url,
          transport: a.transport,
          authKind: a.auth_kind,
          allWorkers: a.all_workers,
          allBots: a.all_bots,
          tools: a.tools.map((t) =>
            toJson(
              ConnectorToolSchema,
              create(ConnectorToolSchema, {
                ...fromJson(ConnectorToolSchema, t),
                accountId: "",
                accountName: "",
                name: "",
              }),
            ),
          ),
          accountIdentity: credentials ? accountIdentity(credentials) : "",
        },
        credentials ? JSON.stringify(credentials) : null,
        a.updated_at,
      );
    }

    for (const app of apps)
      yield* update(
        "oauth_app",
        app.connector_type,
        { type: app.connector_type },
        decryptSecret(key, app.credentials),
        app.updated_at,
      );

    for (const row of records) {
      if (seen.has(row) || row.unsupported || !alive(row)) continue;
      state.last = nextClock(state.last, node);
      row.deleted = { value: true, hlc: state.last, prev: row.deleted.hlc };
      yield* compactTombstone(
        sql,
        owner,
        row,
        node,
        cipherOf(yield* recordCiphers(sql, owner, row.kind, row.global_id)),
      );
      yield* sql`UPDATE config_history SET state='dismissed' WHERE owner_user_id=${owner}::uuid AND kind=${row.kind}
        AND global_id=${row.global_id} AND reason='deleted' AND notice_node_id=${node} AND state='open'`;
      yield* pruneSecrets(sql, owner, row);
      pending.add(row);
    }

    yield* saveRecords(sql, owner, pending, state.last);
    yield* sql`UPDATE config_clock SET hlc=${state.last} WHERE owner_user_id=${owner}::uuid`;
  });
}
