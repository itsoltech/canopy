import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { isRef, type StoredEnvVar } from "./instance-config.ts";
import { encryptSecret, SECRETS_KEY_ID } from "./secrets.ts";

const CREDENTIAL_ENV = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CLIPROXY_API_KEY",
  "XAI_API_KEY",
  "GROK_CODE_XAI_API_KEY",
];

export const isCredentialEnv = (name: string): boolean => CREDENTIAL_ENV.includes(name.toUpperCase());

/** Older native instances could store API keys as ordinary variables. Encrypt them before any UI read. */
export function protectCredentialEnv(sql: SqlClient.SqlClient, key: Buffer, fallbackOwner: string) {
  const protect = (env: readonly StoredEnvVar[], owner: string) =>
    Effect.gen(function* () {
      const next: StoredEnvVar[] = [];

      for (const variable of env) {
        if (isCredentialEnv(variable.name) && !isRef(variable.value)) {
          const id = Bun.randomUUIDv7();
          yield* sql`INSERT INTO secrets (id, owner_user_id, name, ciphertext, key_id, created_by)
          VALUES (${id}::uuid, ${owner}::uuid, ${`instance-${id}`}, ${encryptSecret(key, variable.value)}, ${SECRETS_KEY_ID}, ${owner}::uuid)`;
          next.push({ ...variable, secret: true, value: { secretRef: id } });
        } else next.push(variable);
      }

      return next;
    });

  return Effect.gen(function* () {
    const rows = yield* sql<{
      harness: string;
      id: string;
      env: StoredEnvVar[];
      created_by: string | null;
    }>`SELECT harness, id, env, created_by FROM provider_instances i
      WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(i.env) e WHERE upper(e->>'name') = ANY(${CREDENTIAL_ENV}::text[]) AND jsonb_typeof(e->'value') = 'string') FOR UPDATE`;

    for (const row of rows) {
      const env = yield* protect(row.env, row.created_by ?? fallbackOwner);
      yield* sql`UPDATE provider_instances SET env = ${JSON.stringify(env)}::jsonb, revision = revision + 1 WHERE harness = ${row.harness} AND id = ${row.id}`;
    }

    const overrides = yield* sql<{
      harness: string;
      instance_id: string;
      worker_id: string;
      env: StoredEnvVar[];
      owner_user_id: string | null;
    }>`
      SELECT a.harness, a.instance_id, a.worker_id, a.overrides->'env' AS env, w.owner_user_id FROM provider_instance_workers a JOIN workers w ON w.id = a.worker_id
      WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(a.overrides->'env', '[]')) e WHERE upper(e->>'name') = ANY(${CREDENTIAL_ENV}::text[]) AND jsonb_typeof(e->'value') = 'string') FOR UPDATE OF a`;

    for (const row of overrides) {
      const env = yield* protect(row.env, row.owner_user_id ?? fallbackOwner);
      yield* sql`UPDATE provider_instance_workers SET overrides = jsonb_set(overrides, '{env}', ${JSON.stringify(env)}::jsonb)
        WHERE harness = ${row.harness} AND instance_id = ${row.instance_id} AND worker_id = ${row.worker_id}::uuid`;
    }
  });
}
