import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { InstanceRow, AssignmentRow, SecretRef } from "./instance-config.ts";
import { proxyFingerprint, proxyOptions, proxyRecords, proxyRoot } from "./proxy-records.ts";
import { Invalid } from "./store.ts";

/** Runs inside the instance sync transaction; advisory lock serializes startup and legacy API writes. */
export function migrateProxies(sql: SqlClient.SqlClient, key: Buffer, fallbackOwner: string) {
  const records = proxyRecords(sql, key);

  const ensure = (owner: string, baseUrl: string, ref: SecretRef | null, name: string) =>
    Effect.gen(function* () {
      const root = yield* Effect.try({
        try: () => proxyRoot(baseUrl),
        catch: () => new Invalid("An existing endpoint URL is invalid"),
      });

      const plaintext = yield* records.secret(owner, ref?.secretRef ?? null);
      const fingerprint = proxyFingerprint(key, root, plaintext);

      const existing = (yield* sql<{
        id: string;
      }>`SELECT id FROM proxies WHERE owner_user_id = ${owner}::uuid AND kind = 'cliproxyapi' AND fingerprint = ${fingerprint} ORDER BY created_at LIMIT 1`)[0];

      if (existing) return existing.id;
      const id = Bun.randomUUIDv7();
      yield* sql`INSERT INTO proxies (id, owner_user_id, name, kind, base_url, secret_id, fingerprint, codex)
      VALUES (${id}::uuid, ${owner}::uuid, ${name.slice(0, 80) || "Migrated proxy"}, 'cliproxyapi', ${root}, ${ref?.secretRef ?? null}::uuid,
        ${fingerprint}, ${JSON.stringify(proxyOptions("cliproxyapi"))}::jsonb)`;
      yield* records.audit(owner, id, "proxy.migrated");

      return id;
    });

  return Effect.gen(function* () {
    yield* sql`SELECT pg_advisory_xact_lock(57421957)`;

    const instances = yield* sql<
      InstanceRow & { created_by: string | null }
    >`SELECT * FROM provider_instances WHERE kind = 'endpoint' AND proxy_id IS NULL ORDER BY harness, id FOR UPDATE`;

    for (const instance of instances) {
      const ownerRow = instance.api_key
        ? (yield* sql<{
            owner_user_id: string | null;
          }>`SELECT owner_user_id FROM secrets WHERE id::text = ${instance.api_key.secretRef}`)[0]
        : undefined;

      const owner = instance.created_by ?? ownerRow?.owner_user_id ?? fallbackOwner;
      const id = yield* ensure(owner, instance.base_url, instance.api_key, instance.label);
      yield* sql`UPDATE provider_instances SET proxy_id = ${id}::uuid, created_by = coalesce(created_by, ${owner}::uuid)
        WHERE harness = ${instance.harness} AND id = ${instance.id}`;
    }

    const overrides = yield* sql<
      AssignmentRow & { base_url: string; api_key: SecretRef | null; owner_user_id: string | null; label: string }
    >`
      SELECT w.*, i.base_url, i.api_key, d.owner_user_id, i.label FROM provider_instance_workers w
      JOIN provider_instances i ON i.harness = w.harness AND i.id = w.instance_id JOIN workers d ON d.id = w.worker_id
      WHERE w.proxy_id IS NULL AND i.kind = 'endpoint' AND (w.overrides ? 'baseUrl' OR w.overrides ? 'apiKey') FOR UPDATE OF w`;

    for (const row of overrides) {
      const id = yield* ensure(
        row.owner_user_id ?? fallbackOwner,
        row.overrides.baseUrl ?? row.base_url,
        row.overrides.apiKey ?? row.api_key,
        row.label,
      );

      yield* sql`UPDATE provider_instance_workers SET proxy_id = ${id}::uuid, overrides = overrides - 'baseUrl' - 'apiKey'
        WHERE harness = ${row.harness} AND instance_id = ${row.instance_id} AND worker_id = ${row.worker_id}::uuid`;
    }
  });
}
