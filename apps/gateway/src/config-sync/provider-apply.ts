import { Effect, Predicate } from "effect";
import { type SqlClient } from "effect/sql";
import { INSTANCE_ID, type InstanceRow, type StoredEnvVar } from "../store/instance-config.ts";
import { SECRET_PREFIX } from "../store/instance-checks.ts";
import { proxyFingerprint, type ProxyRow } from "../store/proxy-records.ts";
import { decryptSecret, SECRETS_KEY_ID } from "../store/secrets.ts";
import type { ConfigRow } from "./persistence.ts";
import { alive } from "./provider-records.ts";
import { HARNESSES, instanceColumns, orderedEnv, proxyColumns, valuesOf } from "./provider-values.ts";

export const NOT_SUPPORTED = "Not supported on this computer";
const MISSING_KEY = "A key is missing on this computer";

/** A global id through this computer's aliases (identity merges). */
export function canonicalId(sql: SqlClient.SqlClient, owner: string, kind: string, id: string) {
  return Effect.map(
    sql<{ global_id: string }>`SELECT global_id FROM config_aliases WHERE owner_user_id=${owner}::uuid
      AND kind=${kind} AND alias_id=${id}`,
    (rows) => rows[0]?.global_id ?? id,
  );
}

export function recordOf(sql: SqlClient.SqlClient, owner: string, kind: string, id: string) {
  return Effect.map(
    sql<ConfigRow>`SELECT * FROM config_items WHERE owner_user_id=${owner}::uuid AND kind=${kind} AND global_id=${id}`,
    (rows) => rows[0],
  );
}

/** The local secrets row of the field's current version, created from config_secrets on first use. */
function materializeSecret(sql: SqlClient.SqlClient, owner: string, row: ConfigRow, name: string) {
  return Effect.gen(function* () {
    const hlc = row.fields[name]?.hlc ?? "";

    const version = (yield* sql<{ ciphertext: Uint8Array; secret_id: string | null; present: boolean }>`
      SELECT c.ciphertext,c.secret_id::text,s.id IS NOT NULL AS present FROM config_secrets c
      LEFT JOIN secrets s ON s.id=c.secret_id WHERE c.owner_user_id=${owner}::uuid AND c.kind=${row.kind}
      AND c.global_id=${row.global_id} AND c.field=${name} AND c.hlc=${hlc}`)[0];

    if (!version) return undefined;

    if (version.secret_id && version.present) return version.secret_id;
    const id = Bun.randomUUIDv7();
    yield* sql`INSERT INTO secrets (id, owner_user_id, name, ciphertext, key_id, created_by)
      VALUES (${id}::uuid, ${owner}::uuid, ${`${SECRET_PREFIX}${id}`}, ${version.ciphertext}, ${SECRETS_KEY_ID}, ${owner}::uuid)`;
    yield* sql`UPDATE config_secrets SET secret_id=${id}::uuid WHERE owner_user_id=${owner}::uuid AND kind=${row.kind}
      AND global_id=${row.global_id} AND field=${name} AND hlc=${hlc}`;

    return id;
  });
}

/** Applies a proxy record with this computer's validation; values that do not apply here stay in the record. */
export function applyProxy(sql: SqlClient.SqlClient, owner: string, key: Buffer, row: ConfigRow) {
  return Effect.gen(function* () {
    const current = (yield* sql<ProxyRow>`SELECT * FROM proxies WHERE owner_user_id=${owner}::uuid
      AND id::text=${row.local_id}`)[0];

    if (!alive(row)) {
      if (!current) return;
      // Instances keep the connection they had: base URL and key stay as their own until changed.
      yield* sql`UPDATE provider_instances SET proxy_id=NULL WHERE proxy_id=${current.id}::uuid`;
      yield* sql`UPDATE provider_instance_workers SET proxy_id=NULL WHERE proxy_id=${current.id}::uuid`;
      yield* sql`DELETE FROM proxies WHERE id=${current.id}::uuid AND owner_user_id=${owner}::uuid`;

      return;
    }

    const values = valuesOf(row.fields);
    const columns = proxyColumns(values, current);

    if (!columns || !/^[0-9a-f-]{36}$/.test(row.local_id)) return void (row.unsupported = NOT_SUPPORTED);
    const secretId = values["secret"] ? yield* materializeSecret(sql, owner, row, "secret") : null;

    if (secretId === undefined) return void (row.unsupported = MISSING_KEY);

    const plain = secretId
      ? decryptSecret(
          key,
          (yield* sql<{ ciphertext: Uint8Array }>`SELECT ciphertext FROM secrets WHERE id=${secretId}::uuid`)[0]!
            .ciphertext,
        )
      : "";

    const fingerprint = proxyFingerprint(key, columns.baseUrl, plain);
    yield* sql`INSERT INTO proxies (id, owner_user_id, name, kind, base_url, secret_id, fingerprint, codex)
      VALUES (${row.local_id}::uuid, ${owner}::uuid, ${columns.name}, ${columns.kind}, ${columns.baseUrl}, ${secretId}::uuid,
        ${fingerprint}, ${JSON.stringify(columns.codex)}::jsonb)
      ON CONFLICT (id) DO UPDATE SET name=excluded.name, kind=excluded.kind, base_url=excluded.base_url,
        secret_id=excluded.secret_id, fingerprint=excluded.fingerprint, codex=excluded.codex,
        revision=proxies.revision+1, updated_at=now() WHERE proxies.owner_user_id=${owner}::uuid`;
    row.unsupported = "";
  });
}

/** A free local id: the global slug, else slug-2, slug-3… (another element already uses it here). */
function localSlug(sql: SqlClient.SqlClient, owner: string, harness: string, row: ConfigRow) {
  return Effect.gen(function* () {
    const wanted = row.local_id.slice(0, 58);

    for (let n = 1; n < 1000; n++) {
      const candidate = n === 1 ? wanted : `${wanted}-${n}`;

      if (!INSTANCE_ID.test(candidate)) continue;

      const used = yield* sql`SELECT 1 FROM provider_instances WHERE harness=${harness} AND id=${candidate}
        UNION ALL SELECT 1 FROM config_items WHERE owner_user_id=${owner}::uuid AND kind='instance'
          AND global_id LIKE ${`${harness}:%`} AND local_id=${candidate} AND global_id<>${row.global_id}`;

      if (!used.length) return candidate;
    }

    return undefined;
  });
}

/** Applies an instance record. CLI paths and homes keep this computer's values; worker choices stay local. */
export function applyInstance(sql: SqlClient.SqlClient, owner: string, row: ConfigRow) {
  return Effect.gen(function* () {
    const harness = row.global_id.split(":")[0] ?? "";

    if (!HARNESSES.has(harness)) return void (row.unsupported = NOT_SUPPORTED);

    let current =
      (yield* sql<InstanceRow>`SELECT * FROM provider_instances WHERE harness=${harness} AND id=${row.local_id}`)[0];

    // A row of another owner, or one another record uses (an instance id split by a collision), is not this one.
    const claimed = yield* sql`SELECT 1 FROM config_items WHERE owner_user_id=${owner}::uuid AND kind='instance'
      AND global_id LIKE ${`${harness}:%`} AND local_id=${row.local_id} AND global_id<>${row.global_id}`;

    if (current && ((current.created_by && current.created_by !== owner) || claimed.length)) current = undefined;

    if (!alive(row)) {
      if (current && !current.built_in)
        yield* sql`DELETE FROM provider_instances WHERE harness=${harness} AND id=${current.id}`;

      return;
    }

    const values = valuesOf(row.fields);
    const columns = instanceColumns(values, current);

    if (!columns) return void (row.unsupported = NOT_SUPPORTED);

    if (!current) {
      const slug = yield* localSlug(sql, owner, harness, row);

      if (!slug) return void (row.unsupported = NOT_SUPPORTED);
      row.local_id = slug;
    }

    const proxyGlobal =
      Predicate.isString(values["proxy"]) && values["proxy"]
        ? yield* canonicalId(sql, owner, "proxy", values["proxy"])
        : "";

    const proxyRecord = proxyGlobal ? yield* recordOf(sql, owner, "proxy", proxyGlobal) : undefined;

    const proxy = proxyRecord
      ? (yield* sql<ProxyRow>`SELECT * FROM proxies WHERE owner_user_id=${owner}::uuid AND id::text=${proxyRecord.local_id}`)[0]
      : undefined;

    const endpoint = columns.kind === "endpoint";
    let apiKey: string | null = null;

    if (endpoint && proxy) apiKey = proxy.secret_id;
    else if (endpoint && values["apiKey"]) {
      const id = yield* materializeSecret(sql, owner, row, "apiKey");

      if (!id) return void (row.unsupported = MISSING_KEY);
      apiKey = id;
    }

    const env: StoredEnvVar[] = [];

    for (const variable of orderedEnv(columns.env, current?.env ?? [])) {
      if (!variable.secret) {
        env.push({ name: variable.name, value: variable.value });
        continue;
      }

      const id = yield* materializeSecret(sql, owner, row, `env.${variable.name}`);

      if (!id) return void (row.unsupported = MISSING_KEY);
      env.push({ name: variable.name, secret: true, value: { secretRef: id } });
    }

    const runtime = { ...current?.runtime };
    delete runtime.launchArgs;
    delete runtime.ownLogin;

    if (columns.launchArgs.length) runtime.launchArgs = columns.launchArgs;

    if (columns.ownLogin) runtime.ownLogin = true;
    const [favorites, hidden, shown, custom] = columns.models;
    const baseUrl = endpoint ? (proxy?.base_url ?? columns.baseUrl) : "";
    const key = apiKey ? JSON.stringify({ secretRef: apiKey }) : null;

    yield* sql`INSERT INTO provider_instances (harness, id, label, kind, base_url, api_key, env, runtime, accent_color,
        favorites, hidden_models, shown_models, custom_models, all_workers, created_by, proxy_id)
      VALUES (${harness}, ${row.local_id}, ${columns.label}, ${columns.kind}, ${baseUrl}, ${key}::jsonb,
        ${JSON.stringify(env)}::jsonb, ${JSON.stringify(runtime)}::jsonb, ${columns.accent},
        ${favorites ?? current?.favorites ?? []}::text[], ${hidden ?? current?.hidden_models ?? []}::text[],
        ${shown ?? current?.shown_models ?? []}::text[], ${custom ?? current?.custom_models ?? []}::text[],
        ${columns.allWorkers}, ${owner}::uuid, ${proxy?.id ?? null}::uuid)
      ON CONFLICT (harness, id) DO UPDATE SET label=excluded.label, kind=excluded.kind, base_url=excluded.base_url,
        api_key=excluded.api_key, env=excluded.env, runtime=excluded.runtime, accent_color=excluded.accent_color,
        favorites=excluded.favorites, hidden_models=excluded.hidden_models, shown_models=excluded.shown_models,
        custom_models=excluded.custom_models, all_workers=excluded.all_workers, proxy_id=excluded.proxy_id,
        revision=provider_instances.revision+1, updated_at=now()`;

    // A choice of "all workers" leaves no explicit choice on this computer's workers, as in a local save.
    if (columns.allWorkers && current && !current.all_workers)
      yield* sql`UPDATE provider_instance_workers SET enabled=NULL WHERE harness=${harness} AND instance_id=${row.local_id}`;
    row.unsupported = "";
  });
}

/** Instances whose proxy arrived after them get it now. */
export function applyWaiting(sql: SqlClient.SqlClient, owner: string) {
  return Effect.gen(function* () {
    const rows = yield* sql<ConfigRow>`SELECT c.* FROM config_items c WHERE c.owner_user_id=${owner}::uuid
      AND c.kind='instance' AND c.unsupported='' AND COALESCE(c.fields->'proxy'->>'value','')<>''
      AND EXISTS (SELECT 1 FROM provider_instances i WHERE i.id=c.local_id AND i.harness=split_part(c.global_id,':',1)
        AND i.proxy_id IS NULL)`;

    for (const row of rows) yield* applyInstance(sql, owner, row);
  });
}
