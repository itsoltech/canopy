import { create, fromJsonString, toJson, type JsonValue, type MessageInitShape } from "@bufbuild/protobuf";
import { ConfigAppliedSchema, WorkerConfigSchema, type ConfigApplied, type WorkerConfig } from "@canopy/contracts";
import { Effect, Option, Predicate, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid, one, type Fx } from "./errors.ts";
import { decryptSecret, encryptSecret, SECRETS_KEY_ID } from "./secrets.ts";
import { storedWorkerConfig, type StoredProfile, type StoredWorkerConfig } from "./worker-config-json.ts";

export interface WorkerConfigStore {
  /**
   * Stores a new config version. Profile API keys are never stored inline: pass them as secret ids
   * (secretRefs: profile id -> secrets.id); they are resolved when the config is sent to the worker.
   */
  setWorkerConfig(
    workerId: string,
    config: MessageInitShape<typeof WorkerConfigSchema>,
    updatedBy: string,
    secretRefs?: Readonly<Record<string, string>>,
  ): Fx<bigint>;
  putSecret(input: { ownerUserId: string | null; name: string; plaintext: string; createdBy: string }): Fx<string>;
  workerConfig(workerId: string): Fx<WorkerConfig | undefined>;
  configApplied(workerId: string, report: ConfigApplied): Fx<void>;
}

export function workerConfigStore(sql: SqlClient.SqlClient, secretsKey: Buffer): WorkerConfigStore {
  return {
    setWorkerConfig: (workerId, config, updatedBy, secretRefs = {}) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            version: bigint;
          }>`SELECT version FROM worker_configs WHERE worker_id = ${workerId}::uuid FOR UPDATE`;

          const version = (rows[0] ? BigInt(rows[0].version) : 0n) + 1n;

          const document = Option.getOrThrow(
            storedWorkerConfig(toJson(WorkerConfigSchema, create(WorkerConfigSchema, { ...config, version }))),
          );

          for (const profile of document.profiles ?? []) {
            if (profile.apiKey)
              return yield* Effect.fail(new Invalid(`profile ${profile.id}: pass API keys as secret references`));

            // Secret variables only through the provider instances (InstanceStore), which store them encrypted.
            if (profile.env?.some((v) => v.secret && v.value))
              return yield* Effect.fail(
                new Invalid(`profile ${profile.id}: secret variables go through the profile settings`),
              );
          }

          const stored: StoredWorkerConfig = document.profiles
            ? Object.assign({}, document, {
                profiles: document.profiles.map((profile) => {
                  const ref = profile.id ? secretRefs[profile.id] : undefined;

                  return ref ? Object.assign({}, profile, { apiKey: { secretRef: ref } }) : profile;
                }),
              })
            : document;

          yield* sql`
                  INSERT INTO worker_configs (worker_id, version, config, updated_by) VALUES (${workerId}::uuid, ${version}, ${JSON.stringify(stored)}::jsonb, ${updatedBy}::uuid)
                  ON CONFLICT (worker_id) DO UPDATE SET version = EXCLUDED.version, config = EXCLUDED.config, updated_by = EXCLUDED.updated_by, updated_at = now()`;
          yield* sql`DELETE FROM worker_config_secrets WHERE worker_id = ${workerId}::uuid`;

          for (const secretId of Object.values(secretRefs)) {
            yield* sql`INSERT INTO worker_config_secrets (worker_id, secret_id) VALUES (${workerId}::uuid, ${secretId}::uuid) ON CONFLICT DO NOTHING`;
          }

          return version;
        }),
      ),

    putSecret: ({ ownerUserId, name, plaintext, createdBy }) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ id: string }>`
                INSERT INTO secrets (id, owner_user_id, name, ciphertext, key_id, created_by)
                VALUES (${Bun.randomUUIDv7()}::uuid, ${ownerUserId}::uuid, ${name}, ${encryptSecret(secretsKey, plaintext)}, ${SECRETS_KEY_ID}, ${createdBy}::uuid)
                ON CONFLICT (owner_user_id, name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, key_id = EXCLUDED.key_id, rotated_at = now()
                RETURNING id`;

        return (yield* one(rows, "secret")).id;
      }),

    workerConfig: (workerId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          config: JsonValue | null;
          version: bigint;
          check_minutes: number;
        }>`
                SELECT c.config, c.version, COALESCE((c.config->>'cliUpdateCheckMinutes')::int,
                  (s.settings#>>'{cliUpdates,intervalMinutes}')::int, 360) AS check_minutes
                FROM worker_configs c JOIN workers w ON w.id = c.worker_id
                LEFT JOIN user_settings s ON s.user_id = w.owner_user_id WHERE c.worker_id = ${workerId}::uuid`;

        const config = rows[0]?.config ? Option.getOrThrow(storedWorkerConfig(rows[0].config)) : undefined;

        if (!config) return undefined;

        // Resolve {"secretRef": id} placeholders right before sending; plaintext never touches the table.
        const resolve = (value: Schema.Json) =>
          Effect.gen(function* () {
            const ref = Predicate.hasProperty(value, "secretRef") ? value.secretRef : undefined;

            if (!ref) return value;

            const secret = yield* sql<{
              ciphertext: Uint8Array;
            }>`SELECT ciphertext FROM secrets WHERE id = ${ref}::uuid`;

            return secret[0] ? decryptSecret(secretsKey, secret[0].ciphertext) : "";
          });

        const profiles: StoredProfile[] = [];

        for (const profile of config.profiles ?? []) {
          const env: NonNullable<StoredProfile["env"]>[number][] = [];

          for (const variable of profile.env ?? [])
            env.push(
              variable.value === undefined
                ? variable
                : Object.assign({}, variable, { value: yield* resolve(variable.value) }),
            );

          profiles.push(
            Object.assign(
              {},
              profile,
              profile.apiKey ? { apiKey: yield* resolve(profile.apiKey) } : {},
              profile.env ? { env } : {},
            ),
          );
        }

        const resolved = fromJsonString(
          WorkerConfigSchema,
          JSON.stringify(config.profiles ? Object.assign({}, config, { profiles }) : config),
        );

        resolved.cliUpdateCheckMinutes = rows[0]!.check_minutes;
        resolved.version = BigInt(rows[0]!.version);

        return resolved;
      }),

    configApplied: (workerId, report) =>
      sql`
              UPDATE worker_configs SET applied_version = ${report.version}, applied_ok = ${report.applied}, applied_at = now(),
                                        apply_report = ${JSON.stringify(toJson(ConfigAppliedSchema, report))}::jsonb
               WHERE worker_id = ${workerId}::uuid AND version >= ${report.version}`.pipe(Effect.asVoid),
  };
}
