import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import { type SqlClient } from "effect/sql";
import type { InstanceRow } from "../store/instance-config.ts";
import type { ProxyRow } from "../store/proxy-records.ts";
import { compareClock, nextClock } from "./clock.ts";
import { compactTombstone } from "./merge.ts";
import { configLock, emptyRecord, equalValue, saveRecord, type ConfigRow } from "./persistence.ts";
import {
  ENV_FIELD,
  instanceIdentity,
  instanceValues,
  proxyIdentity,
  proxyValues,
  type SecretRefs,
  type Values,
} from "./provider-values.ts";
import { cipherOf, pruneSecrets, recordCiphers, storeSecret } from "./secrets.ts";

const INSTANCE_FIELDS = new Set([
  "label",
  "kind",
  "baseUrl",
  "proxy",
  "accentColor",
  "launchArgs",
  "ownLogin",
  "allWorkers",
  "favorites",
  "hidden",
  "shown",
  "custom",
  "apiKey",
]);

const PROXY_FIELDS = new Set(["name", "kind", "baseUrl", "codex", "secret"]);

const managed = (kind: string, name: string) =>
  kind === "proxy" ? PROXY_FIELDS.has(name) : INSTANCE_FIELDS.has(name) || ENV_FIELD.test(name);

/**
 * A local write to instances or proxies. The configuration clock is locked first, the order a received batch
 * uses, so a local save and a batch from a linked computer never wait for each other in reverse.
 */
export const configTransaction = <A, E, R>(sql: SqlClient.SqlClient, effect: Effect.Effect<A, E, R>) =>
  sql.withTransaction(Effect.andThen(sql`SELECT 1 FROM config_clock FOR UPDATE`, effect));

export const alive = (row: ConfigRow) => row.deleted.value !== true || Object.keys(row.fields).length > 0;

type Stamped<T> = T & { updated_at: Date };

/**
 * Versions this computer's instances and proxies after a local change, in the caller's transaction. Values a
 * linked computer sent are already in the records, so applying them never versions them again. A field without a
 * version takes the row's own timestamp, so the first bootstrap keeps the later change on either computer.
 */
export function recordProviders(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    const owners = yield* sql<{ owner_user_id: string; node_id: string }>`SELECT owner_user_id::text,node_id
      FROM computer_identity ORDER BY owner_user_id`;

    for (const { owner_user_id, node_id } of owners) yield* recordOwner(sql, owner_user_id, node_id);
  });
}

function recordOwner(sql: SqlClient.SqlClient, owner: string, node: string) {
  return Effect.gen(function* () {
    const clock = yield* configLock(sql, owner);
    const state = { observed: clock.hlc };

    const records = [
      ...(yield* sql<ConfigRow>`SELECT * FROM config_items WHERE owner_user_id=${owner}::uuid
        AND kind IN ('instance','proxy')`),
    ];

    // A worker's own key stays at its home: its proxy is no shared record.
    const proxies = yield* sql<Stamped<ProxyRow>>`SELECT * FROM proxies WHERE owner_user_id=${owner}::uuid
      AND NOT worker_scoped ORDER BY id`;

    const instances =
      yield* sql<InstanceRow>`SELECT i.* FROM provider_instances i LEFT JOIN proxies p ON p.id=i.proxy_id
      WHERE (i.created_by IS NULL OR i.created_by=${owner}::uuid) AND (p.id IS NULL OR p.owner_user_id=${owner}::uuid)
      ORDER BY i.harness,i.id`;

    // Local rows by kind and id: a record pointing at an existing row is never a deletion.
    const seen = new Set<string>();

    const localKey = (row: ConfigRow) =>
      `${row.kind}:${row.kind === "instance" ? row.global_id.split(":")[0] : ""}:${row.local_id}`;

    const recordFor = (kind: string, local: string, preferred: string) => {
      const harness = kind === "instance" ? `${preferred.split(":")[0]}:` : "";

      const found = records.find(
        (r) => r.kind === kind && r.local_id === local && (!harness || r.global_id.startsWith(harness)),
      );

      if (found) return found;
      const taken = records.some((r) => r.kind === kind && r.global_id === preferred);
      const row = emptyRecord(kind, taken ? `${preferred}-${node.slice(0, 8)}` : preferred);
      row.local_id = local;
      records.push(row);

      return row;
    };

    const update = (row: ConfigRow, values: Values, secrets: SecretRefs, updated: Date) =>
      Effect.gen(function* () {
        seen.add(localKey(row));
        const seedClock = `${new Date(updated).getTime()}.0.${node}`;
        let changed = false;

        for (const name of new Set([...Object.keys(values), ...Object.keys(row.fields)])) {
          if (!managed(row.kind, name)) continue;
          const old = row.fields[name];
          let next = values[name] ?? null;
          const ref = secrets.get(name);
          let ciphertext: Uint8Array | undefined;

          if (ref) {
            const current = old
              ? (yield* sql<{ secret_id: string | null }>`SELECT secret_id::text FROM config_secrets
                WHERE owner_user_id=${owner}::uuid AND kind=${row.kind} AND global_id=${row.global_id}
                AND field=${name} AND hlc=${old.hlc}`)[0]
              : undefined;

            if (current?.secret_id === ref) continue;
            ciphertext = (yield* sql<{
              ciphertext: Uint8Array;
            }>`SELECT ciphertext FROM secrets WHERE id=${ref}::uuid`)[0]?.ciphertext;

            if (!ciphertext) continue;
            const token = randomBytes(16).toString("hex");
            next = name.startsWith("env.") ? { secret: token } : token;
          } else if (old ? equalValue(old.value, next) : next === null) continue;

          const fresh = !old && row.deleted.value !== true;
          const hlc = fresh ? seedClock : nextClock(state.observed, node);
          row.fields[name] = { value: next, hlc, prev: old?.hlc ?? "" };

          if (compareClock(hlc, state.observed) > 0) state.observed = hlc;

          if (ciphertext) yield* storeSecret(sql, owner, row, name, hlc, ciphertext, ref);
          changed = true;
        }

        if (!changed) return;
        yield* pruneSecrets(sql, owner, row);
        yield* saveRecord(sql, owner, row, state.observed);
      });

    for (const proxy of proxies) {
      const { values, secrets } = proxyValues(proxy);
      const row = recordFor("proxy", proxy.id, proxy.id);

      if (!row.identity) row.identity = proxyIdentity(values);
      yield* update(row, values, secrets, proxy.updated_at);
    }

    for (const instance of instances) {
      const proxy = instance.proxy_id
        ? (records.find((r) => r.kind === "proxy" && r.local_id === instance.proxy_id)?.global_id ?? "")
        : "";

      const { values, secrets } = instanceValues(instance, proxy);
      const row = recordFor("instance", instance.id, `${instance.harness}:${instance.id}`);

      if (!row.identity)
        row.identity = instanceIdentity(instance.harness, values, instance.base_url, instance.built_in);
      yield* update(row, values, secrets, instance.updated_at);
    }

    // Gone here: a tombstone. Unsupported records never had a local row to lose.
    for (const row of records) {
      if (seen.has(localKey(row)) || row.unsupported || !alive(row) || !row.revision || row.revision === "0") continue;
      const hlc = nextClock(state.observed, node);
      row.deleted = { value: true, hlc, prev: row.deleted.hlc };
      state.observed = compareClock(hlc, state.observed) > 0 ? hlc : state.observed;
      yield* compactTombstone(
        sql,
        owner,
        row,
        node,
        cipherOf(yield* recordCiphers(sql, owner, row.kind, row.global_id)),
      );
      // A deletion made here is not news here; linked computers show it.
      yield* sql`UPDATE config_history SET state='dismissed' WHERE owner_user_id=${owner}::uuid AND kind=${row.kind}
        AND global_id=${row.global_id} AND reason='deleted' AND notice_node_id=${node} AND state='open'`;
      yield* pruneSecrets(sql, owner, row);
      yield* saveRecord(sql, owner, row, state.observed);
    }

    yield* sql`UPDATE config_clock SET hlc=${state.observed} WHERE owner_user_id=${owner}::uuid`;
  });
}
