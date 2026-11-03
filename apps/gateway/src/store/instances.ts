import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ConfigAppliedSchema, Provider, ProviderProfileKind, ui, type ConfigApplied } from "@canopy/contracts";
import { envListProblems } from "@canopy/domain";
import { Context, Effect, Layer } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import {
  canonicalJson,
  effectiveProfiles,
  enabledOn,
  harnessOf,
  INSTANCE_ID,
  instanceKey,
  isRef,
  modelsRule,
  NATIVE_ID,
  profileSecretRefs,
  providerOf,
  type AssignmentRow,
  type Harness,
  type InstanceModelsRule,
  type InstanceRow,
  type SecretRef,
  type StoredEnvVar,
  type StoredOverrides,
  type StoredRuntime,
} from "./instance-config.ts";
import { encryptSecret, SECRETS_KEY_ID } from "./secrets.ts";
import { Invalid, NotFound } from "./store.ts";

/**
 * Global provider instances (docs/worker-config.md, section 9). An instance (harness + id) is defined once here
 * (provider_instances) and enabled on the workers the user chooses (provider_instance_workers, with per-worker
 * overrides). What a worker runs stays its versioned configuration: after every change `sync` writes each
 * affected worker's effective instances (instance-config.ts) into worker_configs.config.profiles as a new version
 * (history kept); the core then pushes it to the workers online. Secrets (endpoint key, variables marked secret)
 * are encrypted into `secrets` and referenced as {"secretRef": "<secrets.id>"}; they never leave this store in
 * clear. Model choices (favorites, visibility, custom models) are the gateway's own and change no version.
 */

/** The change started from an older definition, or an instance in use cannot be deleted. */
export class InstanceConflict extends Error {
  override readonly name = "InstanceConflict";
}

type Fx<A> = Effect.Effect<A, SqlError.SqlError | NotFound | Invalid | InstanceConflict>;

/** Secrets this store (and the per-worker profiles before it) creates; unreferenced ones are deleted after changes. */
const SECRET_PREFIX = "instance-";
const MAX_INSTANCES = 64;
const MAX_MODELS = 2000;
const MAX_PATH = 1024;
const MAX_ARGS = 64;
const ACCENT = /^#[0-9a-f]{6}$/;

interface WorkerRow {
  id: string;
  name: string;
  version: bigint | number | null;
  applied_version: bigint | number | null;
  applied_at: Date | null;
  apply_report: JsonValue | null;
}

interface ConfigRow {
  worker_id: string;
  config: { version?: string; profiles?: unknown[]; [key: string]: unknown };
  version: bigint | number;
}

export interface SaveInstanceInput {
  readonly userId: string;
  readonly request: ui.SaveProviderInstanceRequest;
}

const harnessOrFail = (provider: Provider) => {
  const harness = harnessOf(provider);
  return harness ? Effect.succeed(harness) : Effect.fail(new Invalid("choose Claude or Codex"));
};

const envSettings = (env: readonly StoredEnvVar[]) =>
  env.map((v) => create(ui.ProfileEnvVarSettingsSchema, { name: v.name, secret: v.secret === true, value: v.secret || isRef(v.value) ? "" : v.value }));

const report = (row: WorkerRow): ConfigApplied | undefined =>
  row.apply_report ? fromJson(ConfigAppliedSchema, row.apply_report, { ignoreUnknownFields: true }) : undefined;

function checkPath(label: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length > MAX_PATH || trimmed.includes("\0")) return `${label} is invalid`;
  return undefined;
}

function checkArgs(args: readonly string[]): string | undefined {
  if (args.length > MAX_ARGS) return `at most ${MAX_ARGS} launch arguments`;
  if (args.some((a) => a.length > MAX_PATH || a.includes("\0"))) return "a launch argument is invalid";
  return undefined;
}

function checkBaseUrl(value: string): string | undefined {
  const url = URL.canParse(value.trim()) ? new URL(value.trim()) : undefined;
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return "the endpoint must be an http(s) URL";
  if (url.username || url.password) return "put the key in the API key field, not in the URL";
  return undefined;
}

export class InstanceStore extends Context.Service<
  InstanceStore,
  {
    /** Every instance with its state on every worker (settings screen; no secret values). */
    list(): Fx<ui.ProviderInstance[]>;
    get(harness: Harness, id: string): Fx<ui.ProviderInstance>;
    /** Creates or changes an instance. Returns the workers whose configuration changed. */
    save(input: SaveInstanceInput): Fx<{ harness: Harness; id: string; changed: string[] }>;
    remove(input: { userId: string; request: ui.DeleteProviderInstanceRequest }): Fx<string[]>;
    setWorkers(input: { userId: string; request: ui.SetInstanceWorkersRequest }): Fx<string[]>;
    setWorker(input: { userId: string; request: ui.SetInstanceWorkerRequest }): Fx<string[]>;
    setModels(request: ui.SetInstanceModelsRequest): Fx<void>;
    /**
     * Writes each worker's effective instances into its configuration when they differ (a new version, history
     * kept) and drops this store's secrets nothing references. All workers when `workerIds` is absent.
     * Returns the workers whose configuration changed.
     */
    sync(userId: string, workerIds?: readonly string[]): Fx<string[]>;
    /** Per worker, the instances with their state there (Worker.provider_instances, pickers). */
    workerInstances(): Fx<ReadonlyMap<string, ui.WorkerInstance[]>>;
    /** Every instance's model choices (pickers' catalog, model checks). */
    modelRules(): Fx<InstanceModelsRule[]>;
    /**
     * The CLI registers a worker with an endpoint (CLIProxyAPI): an "cliproxyapi" instance per harness, enabled on
     * the worker; when it already exists with another address or key, they become the worker's overrides.
     */
    registerEndpoint(input: { userId: string; workerId: string; baseUrl: string; apiKey: SecretRef }): Fx<void>;
  }
>()("canopy/gateway/InstanceStore") {
  static readonly layer = (secretsKey: Buffer) =>
    Layer.effect(
      InstanceStore,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        const instances = () => sql<InstanceRow>`SELECT * FROM provider_instances ORDER BY harness, (id <> 'native'), id`;
        const assignments = () => sql<AssignmentRow>`SELECT * FROM provider_instance_workers`;
        const workers = () =>
          sql<WorkerRow>`
            SELECT w.id, w.name, c.version, c.applied_version, c.applied_at, c.apply_report
              FROM workers w LEFT JOIN worker_configs c ON c.worker_id = w.id
             WHERE w.archived_at IS NULL AND w.revoked_at IS NULL ORDER BY w.name, w.id`;
        /** Threads per instance and worker (not archived). */
        const threadUse = () =>
          sql<{ worker_id: string; harness: Harness; id: string; count: bigint | number }>`
            SELECT worker_id, provider AS harness, coalesce(nullif(provider_profile_id, ''), 'native') AS id, count(*) AS count
              FROM threads WHERE archived_at IS NULL AND worker_id IS NOT NULL AND provider IN ('claude', 'codex', 'grok') GROUP BY 1, 2, 3`;

        const lockInstance = (harness: Harness, id: string) =>
          Effect.gen(function* () {
            const rows = yield* sql<InstanceRow>`SELECT * FROM provider_instances WHERE harness = ${harness} AND id = ${id} FOR UPDATE`;
            const row = rows[0];
            if (!row) return yield* Effect.fail(new NotFound(`provider instance ${harness}/${id} not found`));
            return row;
          });

        const putSecret = (userId: string, plaintext: string) =>
          Effect.gen(function* () {
            const id = Bun.randomUUIDv7();
            yield* sql`
              INSERT INTO secrets (id, owner_user_id, name, ciphertext, key_id, created_by)
              VALUES (${id}::uuid, ${userId}::uuid, ${`${SECRET_PREFIX}${id}`}, ${encryptSecret(secretsKey, plaintext)}, ${SECRETS_KEY_ID}, ${userId}::uuid)`;
            return { secretRef: id } satisfies SecretRef;
          });

        /** Variables from the form: names checked like on the worker; a secret without a value keeps the previous one. */
        const envFrom = (userId: string, kind: "native" | "endpoint", input: readonly ui.ProfileEnvVarInput[], previous: readonly StoredEnvVar[]) =>
          Effect.gen(function* () {
            const problem = envListProblems(kind, input.map((v) => ({ name: v.name, value: v.value ?? "" })))[0];
            if (problem) return yield* Effect.fail(new Invalid(problem.message));
            const kept = new Map(previous.map((v) => [v.name, v]));
            const env: StoredEnvVar[] = [];
            for (const variable of input) {
              if (!variable.secret) {
                env.push({ name: variable.name, value: variable.value ?? "" });
                continue;
              }
              if (variable.value !== undefined) {
                env.push({ name: variable.name, secret: true, value: yield* putSecret(userId, variable.value) });
                continue;
              }
              const old = kept.get(variable.name);
              if (!old?.secret || !isRef(old.value)) return yield* Effect.fail(new Invalid(`${variable.name}: enter the secret value`));
              env.push({ name: variable.name, secret: true, value: old.value });
            }
            return env;
          });

        const runtimeFrom = (runtime: ui.InstanceRuntime | undefined, kind: "native" | "endpoint") =>
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
            if (runtime?.ownLogin && kind === "native") stored.ownLogin = true;
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
            for (const workerId of known) {
              const enabled = allWorkers ? null : workerIds.includes(workerId);
              yield* sql`
                INSERT INTO provider_instance_workers (harness, instance_id, worker_id, enabled) VALUES (${harness}, ${id}, ${workerId}::uuid, ${enabled})
                ON CONFLICT (harness, instance_id, worker_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`;
            }
          });

        /** Secrets of this store (and of the per-worker profiles before it) that nothing references any more. */
        const dropUnusedSecrets = () =>
          sql`
            DELETE FROM secrets s
             WHERE (s.name LIKE ${`${SECRET_PREFIX}%`} OR s.name LIKE 'profile-%')
               AND NOT EXISTS (SELECT 1 FROM worker_config_secrets r WHERE r.secret_id = s.id)
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
            const configs = workerIds
              ? workerIds.length === 0
                ? []
                : yield* sql<ConfigRow>`
                    SELECT c.worker_id, c.config, c.version FROM worker_configs c JOIN workers w ON w.id = c.worker_id
                     WHERE c.worker_id = ANY(${workerIds}::uuid[]) AND w.archived_at IS NULL AND w.revoked_at IS NULL
                     ORDER BY c.worker_id FOR UPDATE OF c`
              : yield* sql<ConfigRow>`
                  SELECT c.worker_id, c.config, c.version FROM worker_configs c JOIN workers w ON w.id = c.worker_id
                   WHERE w.archived_at IS NULL AND w.revoked_at IS NULL ORDER BY c.worker_id FOR UPDATE OF c`;
            const changed: string[] = [];
            if (configs.length > 0) {
              const all = yield* instances();
              const rows = yield* assignments();
              const used = yield* threadUse();
              for (const row of configs) {
                const usedHere = new Set(used.filter((u) => u.worker_id === row.worker_id).map((u) => instanceKey(u.harness, u.id)));
                const profiles = effectiveProfiles(all, rows.filter((a) => a.worker_id === row.worker_id), usedHere);
                if (canonicalJson(row.config.profiles ?? []) === canonicalJson(profiles)) continue;
                const next = BigInt(row.version) + 1n;
                const config = { ...row.config, version: String(next), profiles };
                yield* sql`
                  UPDATE worker_configs SET version = ${next}, config = ${JSON.stringify(config)}::jsonb, updated_by = ${userId}::uuid, updated_at = now()
                   WHERE worker_id = ${row.worker_id}::uuid`;
                yield* sql`DELETE FROM worker_config_secrets WHERE worker_id = ${row.worker_id}::uuid`;
                for (const secretId of profileSecretRefs(profiles)) {
                  yield* sql`INSERT INTO worker_config_secrets (worker_id, secret_id) VALUES (${row.worker_id}::uuid, ${secretId}::uuid) ON CONFLICT DO NOTHING`;
                }
                changed.push(row.worker_id);
              }
            }
            yield* dropUnusedSecrets();
            return changed;
          });

        const toUi = (
          row: InstanceRow,
          rows: readonly AssignmentRow[],
          workerRows: readonly WorkerRow[],
          used: readonly { worker_id: string; harness: Harness; id: string; count: bigint | number }[],
        ) => {
          const provider = providerOf(row.harness);
          const ofInstance = used.filter((u) => u.harness === row.harness && u.id === row.id);
          return create(ui.ProviderInstanceSchema, {
            harness: provider,
            id: row.id,
            label: row.label,
            kind: row.kind === "endpoint" ? ProviderProfileKind.CLIPROXYAPI : ProviderProfileKind.NATIVE,
            baseUrl: row.base_url,
            apiKeySet: isRef(row.api_key),
            env: envSettings(row.env ?? []),
            runtime: {
              binaryPath: row.runtime?.binaryPath ?? "",
              homePath: row.runtime?.homePath ?? "",
              shadowHomePath: row.runtime?.shadowHomePath ?? "",
              launchArgs: row.runtime?.launchArgs ?? [],
              ownLogin: row.runtime?.ownLogin === true,
            },
            accentColor: row.accent_color,
            models: { favorites: row.favorites, hidden: row.hidden_models, shown: row.shown_models, custom: row.custom_models },
            allWorkers: row.all_workers,
            builtIn: row.built_in,
            revision: BigInt(row.revision),
            threadCount: ofInstance.reduce((sum, u) => sum + Number(u.count), 0),
            updatedAt: timestampFromDate(new Date(row.updated_at)),
            workers: workerRows.map((w) => {
              const assignment = rows.find((a) => a.harness === row.harness && a.instance_id === row.id && a.worker_id === w.id);
              const reported = report(w)?.profiles.find((p) => p.id === row.id && p.providers.includes(provider));
              const o = assignment?.overrides ?? {};
              return create(ui.InstanceOnWorkerSchema, {
                workerId: w.id,
                enabled: enabledOn(row, assignment),
                explicit: assignment?.enabled !== null && assignment?.enabled !== undefined,
                overrides: {
                  ...(o.binaryPath !== undefined && { binaryPath: o.binaryPath }),
                  ...(o.homePath !== undefined && { homePath: o.homePath }),
                  ...(o.shadowHomePath !== undefined && { shadowHomePath: o.shadowHomePath }),
                  launchArgsSet: o.launchArgs !== undefined,
                  launchArgs: o.launchArgs ?? [],
                  env: envSettings(o.env ?? []),
                  ...(o.baseUrl !== undefined && { baseUrl: o.baseUrl }),
                  apiKeySet: isRef(o.apiKey),
                },
                reported: reported !== undefined,
                available: reported?.available ?? false,
                detail: reported ? reported.detail : w.version === null ? "the worker is not configured yet" : "not reported by the worker yet",
                version: reported?.version ?? "",
                auth: reported?.auth ?? "",
                authenticated: reported?.authenticated ?? false,
                threadCount: Number(ofInstance.find((u) => u.worker_id === w.id)?.count ?? 0),
                ...(w.applied_at && { checkedAt: timestampFromDate(new Date(w.applied_at)) }),
                synced: w.version !== null && w.applied_version !== null && BigInt(w.applied_version) === BigInt(w.version),
              });
            }),
          });
        };

        const list = () =>
          Effect.gen(function* () {
            const [all, rows, workerRows, used] = [yield* instances(), yield* assignments(), yield* workers(), yield* threadUse()];
            return all.map((row) => toUi(row, rows, workerRows, used));
          });

        const get = (harness: Harness, id: string) =>
          Effect.gen(function* () {
            const found = (yield* list()).find((i) => harnessOf(i.harness) === harness && i.id === id);
            if (!found) return yield* Effect.fail(new NotFound(`provider instance ${harness}/${id} not found`));
            return found;
          });

        return InstanceStore.of({
          list,
          get,

          save: ({ userId, request }) =>
            sql.withTransaction(
              Effect.gen(function* () {
                const harness = yield* harnessOrFail(request.harness);
                const id = request.id.trim();
                let existing: InstanceRow | undefined;
                if (request.create) {
                  if (!INSTANCE_ID.test(id)) return yield* Effect.fail(new Invalid("the instance id takes lowercase letters, digits, - and _ (up to 63, starting with a letter or digit)"));
                  if (id === NATIVE_ID) return yield* Effect.fail(new Invalid(`"${NATIVE_ID}" is the built-in device login`));
                  const taken = yield* sql<{ id: string }>`SELECT id FROM provider_instances WHERE harness = ${harness} AND id = ${id}`;
                  if (taken.length > 0) return yield* Effect.fail(new InstanceConflict(`${harness === "claude" ? "Claude" : "Codex"} already has an instance "${id}"`));
                  const count = yield* sql<{ n: bigint | number }>`SELECT count(*) AS n FROM provider_instances`;
                  if (Number(count[0]?.n ?? 0) >= MAX_INSTANCES) return yield* Effect.fail(new Invalid(`at most ${MAX_INSTANCES} provider instances`));
                } else {
                  existing = yield* lockInstance(harness, id);
                  if (request.expectedRevision !== 0n && request.expectedRevision !== BigInt(existing.revision)) {
                    return yield* Effect.fail(new InstanceConflict("the instance changed meanwhile; reload and try again"));
                  }
                }
                const builtIn = existing?.built_in === true;
                const label = request.label.trim();
                if (!label && !builtIn) return yield* Effect.fail(new Invalid("a label is required"));
                if (label.length > 80) return yield* Effect.fail(new Invalid("the label is longer than 80 characters"));
                const kindValue = builtIn ? ProviderProfileKind.NATIVE : request.kind;
                if (kindValue !== ProviderProfileKind.NATIVE && kindValue !== ProviderProfileKind.CLIPROXYAPI) return yield* Effect.fail(new Invalid("choose how the instance connects"));
                const kind = kindValue === ProviderProfileKind.NATIVE ? "native" : "endpoint";
                if (existing && existing.kind !== kind && Number((yield* threadUse()).find((u) => u.harness === harness && u.id === id)?.count ?? 0) > 0) {
                  // Threads of the instance keep their provider session; switching device login and endpoint under them is refused.
                  return yield* Effect.fail(new InstanceConflict("threads use this instance; add a new instance to connect another way"));
                }
                let baseUrl = "";
                if (kind === "endpoint") {
                  const problem = checkBaseUrl(request.baseUrl);
                  if (problem) return yield* Effect.fail(new Invalid(problem));
                  baseUrl = request.baseUrl.trim();
                }
                const accent = request.accentColor.trim().toLowerCase();
                if (accent && !ACCENT.test(accent)) return yield* Effect.fail(new Invalid("the accent color is #rrggbb"));
                const env = yield* envFrom(userId, kind, request.env, existing?.env ?? []);
                const runtime = yield* runtimeFrom(request.runtime, kind);
                // The key: unset keeps it, "" clears it, a value replaces it. Only endpoints have one.
                let apiKey: SecretRef | null = null;
                if (kind === "endpoint") {
                  if (request.apiKey === undefined) apiKey = existing?.api_key ?? null;
                  else if (request.apiKey !== "") apiKey = yield* putSecret(userId, request.apiKey);
                }
                const values = {
                  label,
                  kind,
                  baseUrl,
                  apiKey: apiKey ? JSON.stringify(apiKey) : null,
                  env: JSON.stringify(env),
                  runtime: JSON.stringify(runtime),
                  accent,
                };
                if (existing) {
                  yield* sql`
                    UPDATE provider_instances
                       SET label = ${values.label}, kind = ${values.kind}, base_url = ${values.baseUrl}, api_key = ${values.apiKey}::jsonb, env = ${values.env}::jsonb,
                           runtime = ${values.runtime}::jsonb, accent_color = ${values.accent}, revision = revision + 1, updated_at = now()
                     WHERE harness = ${harness} AND id = ${id}`;
                } else {
                  yield* sql`
                    INSERT INTO provider_instances (harness, id, label, kind, base_url, api_key, env, runtime, accent_color, created_by)
                    VALUES (${harness}, ${id}, ${values.label}, ${values.kind}, ${values.baseUrl}, ${values.apiKey}::jsonb, ${values.env}::jsonb, ${values.runtime}::jsonb, ${values.accent}, ${userId}::uuid)`;
                  yield* assign(harness, id, request.allWorkers, request.workerIds);
                }
                return { harness, id, changed: yield* sync(userId) };
              }),
            ),

          remove: ({ userId, request }) =>
            sql.withTransaction(
              Effect.gen(function* () {
                const harness = yield* harnessOrFail(request.harness);
                const row = yield* lockInstance(harness, request.id);
                if (row.built_in) return yield* Effect.fail(new Invalid("the built-in device login cannot be deleted; turn it off on the workers instead"));
                if (request.expectedRevision !== 0n && request.expectedRevision !== BigInt(row.revision)) {
                  return yield* Effect.fail(new InstanceConflict("the instance changed meanwhile; reload and try again"));
                }
                const used = (yield* threadUse()).filter((u) => u.harness === harness && u.id === row.id).reduce((sum, u) => sum + Number(u.count), 0);
                if (used > 0) {
                  return yield* Effect.fail(
                    new InstanceConflict(`${used} thread${used === 1 ? " uses" : "s use"} this instance; turn it off instead (its threads then show why they cannot run)`),
                  );
                }
                const scheduled = yield* sql`SELECT 1 FROM schedules WHERE target = 'new_thread' AND status IN ('active', 'paused')
                  AND new_thread->>'provider' = ${harness === "claude" ? "PROVIDER_CLAUDE" : harness === "grok" ? "PROVIDER_GROK" : "PROVIDER_CODEX"}
                  AND coalesce(nullif(new_thread->>'providerProfileId', ''), 'native') = ${row.id} LIMIT 1`;
                if (scheduled.length) return yield* Effect.fail(new InstanceConflict("a scheduled task uses this instance; cancel it or turn the instance off instead"));
                yield* sql`DELETE FROM provider_instances WHERE harness = ${harness} AND id = ${row.id}`;
                return yield* sync(userId);
              }),
            ),

          setWorkers: ({ userId, request }) =>
            sql.withTransaction(
              Effect.gen(function* () {
                const harness = yield* harnessOrFail(request.harness);
                yield* lockInstance(harness, request.id);
                yield* assign(harness, request.id, request.allWorkers, request.workerIds);
                return yield* sync(userId);
              }),
            ),

          setWorker: ({ userId, request }) =>
            sql.withTransaction(
              Effect.gen(function* () {
                const harness = yield* harnessOrFail(request.harness);
                const row = yield* lockInstance(harness, request.id);
                if (!(yield* workers()).some((w) => w.id === request.workerId)) return yield* Effect.fail(new NotFound(`worker ${request.workerId} not found`));
                const current = (yield* sql<AssignmentRow>`
                  SELECT * FROM provider_instance_workers WHERE harness = ${harness} AND instance_id = ${row.id} AND worker_id = ${request.workerId}::uuid FOR UPDATE`)[0];
                let overrides: StoredOverrides = current?.overrides ?? {};
                const input = request.overrides;
                if (input) {
                  const problem =
                    checkPath("binary path", input.binaryPath) ??
                    checkPath("home path", input.homePath) ??
                    checkPath("shadow home path", input.shadowHomePath) ??
                    checkArgs(input.launchArgs) ??
                    (input.baseUrl !== undefined && row.kind === "endpoint" ? checkBaseUrl(input.baseUrl) : undefined);
                  if (problem) return yield* Effect.fail(new Invalid(problem));
                  const env = yield* envFrom(userId, row.kind, input.env, overrides.env ?? []);
                  const next: StoredOverrides = {};
                  if (input.binaryPath !== undefined) next.binaryPath = input.binaryPath.trim();
                  if (input.homePath !== undefined) next.homePath = input.homePath.trim();
                  if (input.shadowHomePath !== undefined) next.shadowHomePath = input.shadowHomePath.trim();
                  if (input.launchArgsSet) next.launchArgs = [...input.launchArgs];
                  if (env.length > 0) next.env = env;
                  if (row.kind === "endpoint") {
                    if (input.baseUrl !== undefined) next.baseUrl = input.baseUrl.trim();
                    if (input.apiKey === undefined && overrides.apiKey) next.apiKey = overrides.apiKey;
                    else if (input.apiKey) next.apiKey = yield* putSecret(userId, input.apiKey);
                  }
                  overrides = next;
                }
                const enabled = request.enabled ?? current?.enabled ?? null;
                yield* sql`
                  INSERT INTO provider_instance_workers (harness, instance_id, worker_id, enabled, overrides)
                  VALUES (${harness}, ${row.id}, ${request.workerId}::uuid, ${enabled}, ${JSON.stringify(overrides)}::jsonb)
                  ON CONFLICT (harness, instance_id, worker_id) DO UPDATE SET enabled = EXCLUDED.enabled, overrides = EXCLUDED.overrides, updated_at = now()`;
                return yield* sync(userId, [request.workerId]);
              }),
            ),

          setModels: (request) =>
            Effect.gen(function* () {
              const harness = yield* harnessOrFail(request.harness);
              const models = request.models;
              const lists = [models?.favorites ?? [], models?.hidden ?? [], models?.shown ?? [], models?.custom ?? []].map((l) => [...new Set(l.map((m) => m.trim()).filter(Boolean))]);
              const [favorites = [], hidden = [], shown = [], custom = []] = lists;
              if (lists.some((l) => l.length > MAX_MODELS) || lists.flat().some((m) => m.length > 200 || /\s/.test(m))) return yield* Effect.fail(new Invalid("invalid model list"));
              if (custom.length > 100) return yield* Effect.fail(new Invalid("at most 100 custom models"));
              if (request.favoritesOnly) {
                const updated = yield* sql`UPDATE provider_instances SET favorites = ${favorites}::text[], updated_at = now() WHERE harness = ${harness} AND id = ${request.id} RETURNING id`;
                if (updated.length === 0) return yield* Effect.fail(new NotFound(`provider instance ${harness}/${request.id} not found`));
                return;
              }
              const rows = yield* sql`
                UPDATE provider_instances
                   SET favorites = ${favorites}::text[], hidden_models = ${hidden}::text[], shown_models = ${shown}::text[], custom_models = ${custom}::text[], updated_at = now()
                 WHERE harness = ${harness} AND id = ${request.id} RETURNING id`;
              if (rows.length === 0) return yield* Effect.fail(new NotFound(`provider instance ${harness}/${request.id} not found`));
            }),

          sync: (userId, workerIds) => sql.withTransaction(sync(userId, workerIds)),

          workerInstances: () =>
            Effect.gen(function* () {
              const [all, rows, workerRows] = [yield* instances(), yield* assignments(), yield* workers()];
              return new Map(
                workerRows.map((w) => {
                  const applied = report(w);
                  return [
                    w.id,
                    all.map((row) => {
                      const provider = providerOf(row.harness);
                      const reported = applied?.profiles.find((p) => p.id === row.id && p.providers.includes(provider));
                      const assignment = rows.find((a) => a.harness === row.harness && a.instance_id === row.id && a.worker_id === w.id);
                      return create(ui.WorkerInstanceSchema, {
                        harness: provider,
                        id: row.id,
                        label: row.label,
                        accentColor: row.accent_color,
                        enabled: enabledOn(row, assignment),
                        available: reported?.available ?? false,
                        detail: reported ? reported.detail : "not reported by the worker yet",
                        favorites: row.favorites,
                      });
                    }),
                  ] as const;
                }),
              );
            }),

          modelRules: () => instances().pipe(Effect.map((rows) => rows.map(modelsRule))),

          registerEndpoint: ({ userId, workerId, baseUrl, apiKey }) =>
            sql.withTransaction(
              Effect.gen(function* () {
                const problem = checkBaseUrl(baseUrl);
                if (problem) return yield* Effect.fail(new Invalid(problem));
                for (const harness of ["claude", "codex", "grok"] as const) {
                  const found = (yield* sql<InstanceRow>`SELECT * FROM provider_instances WHERE harness = ${harness} AND id = 'cliproxyapi' FOR UPDATE`)[0];
                  let overrides: StoredOverrides = {};
                  if (!found) {
                    yield* sql`
                      INSERT INTO provider_instances (harness, id, label, kind, base_url, api_key, created_by)
                      VALUES (${harness}, 'cliproxyapi', 'CLIProxyAPI', 'endpoint', ${baseUrl}, ${JSON.stringify(apiKey)}::jsonb, ${userId}::uuid)`;
                  } else if (found.kind !== "endpoint") {
                    return yield* Effect.fail(new Invalid(`${harness}/cliproxyapi exists and is not an endpoint`));
                  } else {
                    if (found.base_url !== baseUrl) overrides.baseUrl = baseUrl;
                    if (found.api_key?.secretRef !== apiKey.secretRef) overrides.apiKey = apiKey;
                  }
                  yield* sql`
                    INSERT INTO provider_instance_workers (harness, instance_id, worker_id, enabled, overrides)
                    VALUES (${harness}, 'cliproxyapi', ${workerId}::uuid, true, ${JSON.stringify(overrides)}::jsonb)
                    ON CONFLICT (harness, instance_id, worker_id) DO UPDATE SET enabled = true, overrides = EXCLUDED.overrides, updated_at = now()`;
                  overrides = {};
                }
              }),
            ),
        });
      }),
    );
}
