import { ProviderProfileKind } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import {
  INSTANCE_ID,
  NATIVE_ID,
  type AssignmentRow,
  type InstanceRow,
  type SecretRef,
  type StoredOverrides,
  storedProvider,
} from "./instance-config.ts";
import { Invalid, NotFound } from "./store.ts";
import {
  ACCENT,
  InstanceConflict,
  MAX_INSTANCES,
  checkArgs,
  checkBaseUrl,
  checkPath,
  harnessOrFail,
  type InstanceApi,
} from "./instance-checks.ts";
import type { InstanceCore } from "./instance-queries.ts";
import { proxySupports, proxyRecords } from "./proxies.ts";

/** Creating or changing an instance. */
export function instanceSave(
  sql: SqlClient.SqlClient,
  core: InstanceCore,
  secretsKey: Buffer,
): Pick<InstanceApi, "save"> {
  const { lockInstance, putSecret, envFrom, runtimeFrom, assign, sync } = core;

  return {
    save: ({ userId, request }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const harness = yield* harnessOrFail(request.harness);
          const id = request.id.trim();
          let existing: InstanceRow | undefined;

          if (request.create) {
            if (!INSTANCE_ID.test(id))
              return yield* Effect.fail(
                new Invalid(
                  "the instance id takes lowercase letters, digits, - and _ (up to 63, starting with a letter or digit)",
                ),
              );

            if (id === NATIVE_ID) return yield* Effect.fail(new Invalid(`"${NATIVE_ID}" is the built-in device login`));

            const taken = yield* sql<{
              id: string;
            }>`SELECT id FROM provider_instances WHERE harness = ${harness} AND id = ${id}`;

            if (taken.length > 0)
              return yield* Effect.fail(
                new InstanceConflict(`${harness === "claude" ? "Claude" : "Codex"} already has an instance "${id}"`),
              );
            const count = yield* sql<{ n: bigint | number }>`SELECT count(*) AS n FROM provider_instances`;

            if (Number(count[0]?.n ?? 0) >= MAX_INSTANCES)
              return yield* Effect.fail(new Invalid(`at most ${MAX_INSTANCES} provider instances`));
          } else {
            existing = yield* lockInstance(harness, id);

            if (existing.proxy_id) yield* proxyRecords(sql, secretsKey).get(userId, existing.proxy_id);

            if (existing.created_by && existing.created_by !== userId)
              return yield* Effect.fail(new NotFound("provider instance not found"));

            if (request.expectedRevision !== 0n && request.expectedRevision !== BigInt(existing.revision)) {
              return yield* Effect.fail(new InstanceConflict("the instance changed meanwhile; reload and try again"));
            }
          }

          const builtIn = existing?.built_in === true;
          const label = request.label.trim();

          if (!label && !builtIn) return yield* Effect.fail(new Invalid("a label is required"));

          if (label.length > 80) return yield* Effect.fail(new Invalid("the label is longer than 80 characters"));
          const kindValue = request.kind;

          if (kindValue !== ProviderProfileKind.NATIVE && kindValue !== ProviderProfileKind.CLIPROXYAPI)
            return yield* Effect.fail(new Invalid("choose how the instance connects"));
          const kind = kindValue === ProviderProfileKind.NATIVE ? "native" : "endpoint";

          let baseUrl = "";

          const proxy =
            kind === "endpoint" && request.proxyId
              ? yield* proxyRecords(sql, secretsKey).get(userId, request.proxyId)
              : undefined;

          if (proxy && !proxySupports(proxy.kind, harness))
            return yield* Effect.fail(new Invalid("This proxy does not support this harness"));

          if (kind === "endpoint") {
            const problem = checkBaseUrl(proxy?.base_url ?? request.baseUrl);

            if (problem) return yield* Effect.fail(new Invalid(problem));
            baseUrl = proxy?.base_url ?? request.baseUrl.trim();
          }

          const accent = request.accentColor.trim().toLowerCase();

          if (accent && !ACCENT.test(accent)) return yield* Effect.fail(new Invalid("the accent color is #rrggbb"));
          const env = yield* envFrom(userId, kind, request.env, existing?.env ?? []);
          const runtime = request.runtime ? yield* runtimeFrom(request.runtime) : { ...existing?.runtime };

          // Own login also selects the session home. Keep it dormant while using a proxy.
          if (kind === "endpoint" && existing?.runtime.ownLogin) runtime.ownLogin = true;
          // The key: unset keeps it, "" clears it, a value replaces it. Only endpoints have one.
          let apiKey: SecretRef | null = null;

          if (kind === "endpoint") {
            if (proxy) apiKey = proxy.secret_id ? { secretRef: proxy.secret_id } : null;
            else if (request.apiKey === undefined) apiKey = existing?.api_key ?? null;
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
                           runtime = ${values.runtime}::jsonb, accent_color = ${values.accent}, revision = revision + 1, updated_at = now(), created_by = coalesce(created_by, ${userId}::uuid)
                           , proxy_id = ${proxy?.id ?? null}::uuid
                     WHERE harness = ${harness} AND id = ${id}`;
          } else {
            yield* sql`
                    INSERT INTO provider_instances (harness, id, label, kind, base_url, api_key, env, runtime, accent_color, created_by, proxy_id)
                    VALUES (${harness}, ${id}, ${values.label}, ${values.kind}, ${values.baseUrl}, ${values.apiKey}::jsonb, ${values.env}::jsonb, ${values.runtime}::jsonb, ${values.accent}, ${userId}::uuid, ${proxy?.id ?? null}::uuid)`;
            yield* assign(harness, id, request.allWorkers, request.workerIds);
          }

          if (existing && existing.kind !== kind) {
            yield* sql`INSERT INTO audit_log (id, actor_user_id, action, target_type, details)
              VALUES (${Bun.randomUUIDv7()}::uuid, ${userId}::uuid, 'provider.connection_changed', 'provider_instance',
                ${JSON.stringify({ harness, id, from: existing.kind, to: kind })}::jsonb)`;
          }

          return { harness, id, changed: yield* sync(userId) };
        }),
      ),
  };
}

/** Deleting an instance and enabling it on workers. */
export function instanceMutations(
  sql: SqlClient.SqlClient,
  core: InstanceCore,
  secretsKey: Buffer,
): Pick<InstanceApi, "remove" | "setWorkers" | "setWorker"> {
  const { workers, threadUse, lockInstance, putSecret, envFrom, assign, sync } = core;

  return {
    remove: ({ userId, request }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const harness = yield* harnessOrFail(request.harness);
          const row = yield* lockInstance(harness, request.id);
          yield* core.get(harness, row.id, userId);

          if (row.built_in)
            return yield* Effect.fail(
              new Invalid("the built-in device login cannot be deleted; turn it off on the workers instead"),
            );

          if (request.expectedRevision !== 0n && request.expectedRevision !== BigInt(row.revision)) {
            return yield* Effect.fail(new InstanceConflict("the instance changed meanwhile; reload and try again"));
          }

          const used = (yield* threadUse())
            .filter((u) => u.harness === harness && u.id === row.id)
            .reduce((sum, u) => sum + Number(u.count), 0);

          if (used > 0) {
            return yield* Effect.fail(
              new InstanceConflict(
                `${used} thread${used === 1 ? " uses" : "s use"} this instance; turn it off instead (its threads then show why they cannot run)`,
              ),
            );
          }

          const scheduled =
            yield* sql`SELECT 1 FROM schedules WHERE target = 'new_thread' AND status IN ('active', 'paused')
                  AND new_thread->>'provider' = ${storedProvider(harness)}
                  AND coalesce(nullif(new_thread->>'providerProfileId', ''), 'native') = ${row.id} LIMIT 1`;

          if (scheduled.length)
            return yield* Effect.fail(
              new InstanceConflict("a scheduled task uses this instance; cancel it or turn the instance off instead"),
            );
          yield* sql`DELETE FROM provider_instances WHERE harness = ${harness} AND id = ${row.id}`;

          return yield* sync(userId);
        }),
      ),
    setWorkers: ({ userId, request }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const harness = yield* harnessOrFail(request.harness);
          yield* lockInstance(harness, request.id);
          yield* core.get(harness, request.id, userId);
          yield* assign(harness, request.id, request.allWorkers, request.workerIds);

          return yield* sync(userId);
        }),
      ),
    setWorker: ({ userId, request }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const harness = yield* harnessOrFail(request.harness);
          const row = yield* lockInstance(harness, request.id);
          yield* core.get(harness, row.id, userId);

          if (!(yield* workers()).some((w) => w.id === request.workerId))
            return yield* Effect.fail(new NotFound(`worker ${request.workerId} not found`));

          const current = (yield* sql<AssignmentRow>`
                  SELECT * FROM provider_instance_workers WHERE harness = ${harness} AND instance_id = ${row.id} AND worker_id = ${request.workerId}::uuid FOR UPDATE`)[0];

          let overrides: StoredOverrides = current?.overrides ?? {};
          let proxyId = current?.proxy_id ?? null;
          const input = request.overrides;

          if (input) {
            if (input.proxyId === undefined && (input.baseUrl !== undefined || input.apiKey !== undefined) && proxyId) {
              const previous = yield* proxyRecords(sql, secretsKey).get(userId, proxyId);
              overrides = {
                ...overrides,
                baseUrl: previous.base_url,
                ...(previous.secret_id && { apiKey: { secretRef: previous.secret_id } }),
              };
              proxyId = null;
            }

            if (input.proxyId !== undefined) {
              if (row.kind !== "endpoint")
                return yield* Effect.fail(new Invalid("Device login cannot use a proxy override"));
              const proxy = input.proxyId ? yield* proxyRecords(sql, secretsKey).get(userId, input.proxyId) : undefined;

              if (proxy && !proxySupports(proxy.kind, harness))
                return yield* Effect.fail(new Invalid("This proxy does not support this harness"));
              proxyId = proxy?.id ?? null;
            }

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
              else if (overrides.baseUrl && input.proxyId === undefined) next.baseUrl = overrides.baseUrl;

              if (input.apiKey === undefined && overrides.apiKey) next.apiKey = overrides.apiKey;
              else if (input.apiKey) next.apiKey = yield* putSecret(userId, input.apiKey);
            }

            overrides = next;
          }

          const enabled = request.enabled ?? current?.enabled ?? null;
          yield* sql`
                    INSERT INTO provider_instance_workers (harness, instance_id, worker_id, enabled, overrides, proxy_id)
                    VALUES (${harness}, ${row.id}, ${request.workerId}::uuid, ${enabled}, ${JSON.stringify(overrides)}::jsonb, ${proxyId}::uuid)
                    ON CONFLICT (harness, instance_id, worker_id) DO UPDATE SET enabled = EXCLUDED.enabled, overrides = EXCLUDED.overrides, proxy_id = EXCLUDED.proxy_id, updated_at = now()`;

          return yield* sync(userId, [request.workerId]);
        }),
      ),
  };
}
