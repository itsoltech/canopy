import { ui } from "@canopy/contracts";
import { envListProblems } from "@canopy/domain";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import {
  canonicalJson,
  effectiveProfiles,
  harnessOf,
  instanceKey,
  isRef,
  profileSecretRefs,
  type AssignmentRow,
  type Harness,
  type InstanceRow,
  type SecretRef,
  type StoredEnvVar,
  type StoredRuntime,
} from "./instance-config.ts";
import { encryptSecret, SECRETS_KEY_ID } from "./secrets.ts";
import { Invalid, NotFound } from "./store.ts";
import { SECRET_PREFIX, checkArgs, checkPath, toUi, type ConfigRow, type WorkerRow } from "./instance-checks.ts";
import { migrateProxies } from "./proxy-migration.ts";
import { isCredentialEnv, protectCredentialEnv } from "./credential-env.ts";
import { recordProviders } from "../config-sync/provider-records.ts";

/** Instances, assignments and workers as stored, and the settings view of them. */
export function instanceReads(sql: SqlClient.SqlClient) {
  const instances = (
    userId?: string,
  ) => sql<InstanceRow>`SELECT i.*, p.codex AS proxy_codex, p.owner_user_id AS proxy_owner
    FROM provider_instances i LEFT JOIN proxies p ON p.id = i.proxy_id
    WHERE (${userId ?? null}::uuid IS NULL OR i.created_by IS NULL OR i.created_by=${userId ?? null}::uuid)
      AND (${userId ?? null}::uuid IS NULL OR p.owner_user_id IS NULL OR p.owner_user_id=${userId ?? null}::uuid)
    ORDER BY harness, (i.id <> 'native'), i.id`;

  const assignments = (userId?: string) => sql<AssignmentRow>`SELECT w.*, p.codex AS proxy_codex,
    CASE WHEN p.id IS NULL THEN w.overrides ELSE w.overrides || jsonb_build_object('baseUrl', p.base_url, 'apiKey',
      CASE WHEN p.secret_id IS NULL THEN NULL ELSE jsonb_build_object('secretRef', p.secret_id::text) END) END AS overrides
    FROM provider_instance_workers w JOIN workers host ON host.id=w.worker_id LEFT JOIN proxies p ON p.id = w.proxy_id
    WHERE (${userId ?? null}::uuid IS NULL OR host.owner_user_id IS NULL OR host.owner_user_id=${userId ?? null}::uuid)`;

  const workers = (userId?: string) =>
    sql<WorkerRow>`
            SELECT w.id, w.name, c.version, c.applied_version, c.applied_at, c.apply_report
              FROM workers w LEFT JOIN worker_configs c ON c.worker_id = w.id
             WHERE w.archived_at IS NULL AND w.revoked_at IS NULL
               AND (${userId ?? null}::uuid IS NULL OR w.owner_user_id IS NULL OR w.owner_user_id=${userId ?? null}::uuid)
             ORDER BY w.name, w.id`;

  /** Threads per instance and worker (not archived). */
  const threadUse = (userId?: string) =>
    sql<{ worker_id: string; harness: Harness; id: string; count: bigint | number }>`
            SELECT worker_id, provider AS harness, coalesce(nullif(provider_profile_id, ''), 'native') AS id, count(*) AS count
              FROM threads WHERE archived_at IS NULL AND worker_id IS NOT NULL AND provider IN ('claude', 'codex', 'grok')
                AND (${userId ?? null}::uuid IS NULL OR owner_user_id=${userId ?? null}::uuid) GROUP BY 1, 2, 3`;

  const lockInstance = (harness: Harness, id: string) =>
    Effect.gen(function* () {
      const rows =
        yield* sql<InstanceRow>`SELECT * FROM provider_instances WHERE harness = ${harness} AND id = ${id} FOR UPDATE`;

      const row = rows[0];

      if (!row) return yield* Effect.fail(new NotFound(`provider instance ${harness}/${id} not found`));

      return row;
    });

  const list = (userId?: string) =>
    Effect.gen(function* () {
      const [all, rows, workerRows, used] = [
        yield* instances(userId),
        yield* assignments(userId),
        yield* workers(userId),
        yield* threadUse(userId),
      ];

      return all.map((row) => toUi(row, rows, workerRows, used));
    });

  const get = (harness: Harness, id: string, userId?: string) =>
    Effect.gen(function* () {
      const found = (yield* list(userId)).find((i) => harnessOf(i.harness) === harness && i.id === id);

      if (!found) return yield* Effect.fail(new NotFound(`provider instance ${harness}/${id} not found`));

      return found;
    });

  return { instances, assignments, workers, threadUse, lockInstance, list, get };
}

/** Writes shared by the changes: secrets, variables, runtime and worker assignments. */
export function instanceWrites(sql: SqlClient.SqlClient, secretsKey: Buffer, reads: InstanceReads) {
  const { workers } = reads;

  const putSecret = (userId: string, plaintext: string) =>
    Effect.gen(function* () {
      const id = Bun.randomUUIDv7();
      yield* sql`
              INSERT INTO secrets (id, owner_user_id, name, ciphertext, key_id, created_by)
              VALUES (${id}::uuid, ${userId}::uuid, ${`${SECRET_PREFIX}${id}`}, ${encryptSecret(secretsKey, plaintext)}, ${SECRETS_KEY_ID}, ${userId}::uuid)`;

      return { secretRef: id } satisfies SecretRef;
    });

  /** Variables from the form: names checked like on the worker; a secret without a value keeps the previous one. */
  const envFrom = (
    userId: string,
    kind: "native" | "endpoint",
    input: readonly ui.ProfileEnvVarInput[],
    previous: readonly StoredEnvVar[],
  ) =>
    Effect.gen(function* () {
      const problem = envListProblems(
        kind,
        input.map((v) => ({ name: v.name, value: v.value ?? "" })),
      )[0];

      if (problem) return yield* Effect.fail(new Invalid(problem.message));
      const kept = new Map(previous.map((v) => [v.name, v]));
      const env: StoredEnvVar[] = [];

      for (const variable of input) {
        if (!variable.secret && !isCredentialEnv(variable.name)) {
          env.push({ name: variable.name, value: variable.value ?? "" });
          continue;
        }

        if (variable.value !== undefined) {
          env.push({ name: variable.name, secret: true, value: yield* putSecret(userId, variable.value) });
          continue;
        }

        const old = kept.get(variable.name);

        if (!old?.secret || !isRef(old.value))
          return yield* Effect.fail(new Invalid(`${variable.name}: Enter the secret value.`));
        env.push({ name: variable.name, secret: true, value: old.value });
      }

      return env;
    });

  const runtimeFrom = (runtime: ui.InstanceRuntime | undefined) =>
    Effect.gen(function* () {
      const problem =
        checkPath("binary path", runtime?.binaryPath) ??
        checkPath("home path", runtime?.homePath) ??
        checkPath("shadow home path", runtime?.shadowHomePath) ??
        checkArgs(runtime?.launchArgs ?? []);

      if (problem) return yield* Effect.fail(new Invalid(problem));
      const stored: StoredRuntime = {};

      if (runtime?.binaryPath.trim()) stored.binaryPath = runtime.binaryPath.trim();

      if (runtime?.homePath.trim()) stored.homePath = runtime.homePath.trim();

      if (runtime?.shadowHomePath.trim()) stored.shadowHomePath = runtime.shadowHomePath.trim();

      if (runtime?.launchArgs.length) stored.launchArgs = [...runtime.launchArgs];

      if (runtime?.ownLogin) stored.ownLogin = true;

      return stored;
    });

  /** Replaces the worker's assignments of an instance: all workers, or exactly the listed ones. */
  const assign = (harness: Harness, id: string, allWorkers: boolean, workerIds: readonly string[]) =>
    Effect.gen(function* () {
      const known = new Set((yield* workers()).map((w) => w.id));
      const unknown = workerIds.find((w) => !known.has(w));

      if (unknown) return yield* Effect.fail(new NotFound(`worker ${unknown} not found`));
      yield* sql`UPDATE provider_instances SET all_workers = ${allWorkers}, updated_at = now() WHERE harness = ${harness} AND id = ${id}`;

      // All workers: no worker keeps an explicit choice. Chosen workers: on for them, off for the rest.
      yield* sql`INSERT INTO provider_instance_workers(harness,instance_id,worker_id,enabled)
        SELECT ${harness},${id},worker,CASE WHEN ${allWorkers} THEN NULL ELSE worker=ANY(${[...workerIds]}::uuid[]) END
        FROM unnest(${[...known]}::uuid[]) worker
        ON CONFLICT(harness,instance_id,worker_id) DO UPDATE SET enabled=excluded.enabled,updated_at=now()`;
    });

  return { putSecret, envFrom, runtimeFrom, assign };
}

/** Writes the workers' effective instances into their configurations. */
export function instanceSync(sql: SqlClient.SqlClient, reads: InstanceReads, secretsKey: Buffer) {
  const { instances, assignments, threadUse } = reads;

  /** Secrets of this store (and of the per-worker profiles before it) that nothing references any more. */
  const dropUnusedSecrets = () =>
    sql`
            DELETE FROM secrets s
             WHERE (s.name LIKE ${`${SECRET_PREFIX}%`} OR s.name LIKE 'profile-%')
               AND NOT EXISTS (SELECT 1 FROM worker_config_secrets r WHERE r.secret_id = s.id)
               AND NOT EXISTS (SELECT 1 FROM proxies p WHERE p.secret_id = s.id)
               AND NOT EXISTS (
                 SELECT 1 FROM provider_instances i
                  WHERE i.api_key ->> 'secretRef' = s.id::text
                     OR i.env @> jsonb_build_array(jsonb_build_object('value', jsonb_build_object('secretRef', s.id::text))))
               AND NOT EXISTS (
                 SELECT 1 FROM provider_instance_workers o
                  WHERE o.overrides -> 'apiKey' ->> 'secretRef' = s.id::text
                     OR o.overrides -> 'env' @> jsonb_build_array(jsonb_build_object('value', jsonb_build_object('secretRef', s.id::text))))`;

  const sync = (userId: string, workerIds?: readonly string[]) =>
    Effect.gen(function* () {
      yield* migrateProxies(sql, secretsKey, userId);
      yield* protectCredentialEnv(sql, secretsKey, userId);
      // Compatibility fields also serve gateway bots and linked-computer exports. Proxy is their source of truth.
      yield* sql`UPDATE provider_instances i SET base_url = p.base_url,
        api_key = CASE WHEN p.secret_id IS NULL THEN NULL ELSE jsonb_build_object('secretRef', p.secret_id::text) END
        FROM proxies p WHERE i.proxy_id = p.id`;

      const configs = workerIds
        ? workerIds.length === 0
          ? []
          : yield* sql<ConfigRow>`
                    SELECT c.worker_id, c.config, c.version, w.owner_user_id FROM worker_configs c JOIN workers w ON w.id = c.worker_id
                     WHERE c.worker_id = ANY(${workerIds}::uuid[]) AND w.archived_at IS NULL AND w.revoked_at IS NULL
                     ORDER BY c.worker_id FOR UPDATE OF c`
        : yield* sql<ConfigRow>`
                  SELECT c.worker_id, c.config, c.version, w.owner_user_id FROM worker_configs c JOIN workers w ON w.id = c.worker_id
                   WHERE w.archived_at IS NULL AND w.revoked_at IS NULL ORDER BY c.worker_id FOR UPDATE OF c`;

      const changed: string[] = [];

      if (configs.length > 0) {
        const all = yield* instances();
        const rows = yield* assignments();
        const used = yield* threadUse();

        for (const row of configs) {
          const usedHere = new Set(
            used.filter((u) => u.worker_id === row.worker_id).map((u) => instanceKey(u.harness, u.id)),
          );

          const profiles = effectiveProfiles(
            all.filter(
              (i) =>
                (!i.created_by || !row.owner_user_id || i.created_by === row.owner_user_id) &&
                (!i.proxy_owner || !row.owner_user_id || i.proxy_owner === row.owner_user_id),
            ),
            rows.filter((a) => a.worker_id === row.worker_id),
            usedHere,
          );

          if (canonicalJson(row.config.profiles ?? []) === canonicalJson(profiles)) continue;
          const next = BigInt(row.version) + 1n;
          const config = { ...row.config, version: String(next), profiles };
          yield* sql`
                  UPDATE worker_configs SET version = ${next}, config = ${JSON.stringify(config)}::jsonb, updated_by = ${userId}::uuid, updated_at = now()
                   WHERE worker_id = ${row.worker_id}::uuid`;
          yield* sql`DELETE FROM worker_config_secrets WHERE worker_id = ${row.worker_id}::uuid`;

          const refs = profileSecretRefs(profiles);

          if (refs.length)
            yield* sql`INSERT INTO worker_config_secrets(worker_id,secret_id)
            SELECT ${row.worker_id}::uuid,ref FROM unnest(${refs}::uuid[]) ref ON CONFLICT DO NOTHING`;

          changed.push(row.worker_id);
        }
      }

      yield* dropUnusedSecrets();
      // Same transaction: linked computers see the change exactly when it commits here.
      yield* recordProviders(sql);

      return changed;
    });

  return { dropUnusedSecrets, sync };
}

type InstanceReads = ReturnType<typeof instanceReads>;

export type InstanceCore = InstanceReads & ReturnType<typeof instanceWrites> & ReturnType<typeof instanceSync>;
