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

/** Creating or changing an instance. */
export function instanceSave(sql: SqlClient.SqlClient, core: InstanceCore): Pick<InstanceApi, "save"> {
  const { threadUse, lockInstance, putSecret, envFrom, runtimeFrom, assign, sync } = core;

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

            if (request.expectedRevision !== 0n && request.expectedRevision !== BigInt(existing.revision)) {
              return yield* Effect.fail(new InstanceConflict("the instance changed meanwhile; reload and try again"));
            }
          }

          const builtIn = existing?.built_in === true;
          const label = request.label.trim();

          if (!label && !builtIn) return yield* Effect.fail(new Invalid("a label is required"));

          if (label.length > 80) return yield* Effect.fail(new Invalid("the label is longer than 80 characters"));
          const kindValue = builtIn ? ProviderProfileKind.NATIVE : request.kind;

          if (kindValue !== ProviderProfileKind.NATIVE && kindValue !== ProviderProfileKind.CLIPROXYAPI)
            return yield* Effect.fail(new Invalid("choose how the instance connects"));
          const kind = kindValue === ProviderProfileKind.NATIVE ? "native" : "endpoint";

          if (
            existing &&
            existing.kind !== kind &&
            Number((yield* threadUse()).find((u) => u.harness === harness && u.id === id)?.count ?? 0) > 0
          ) {
            // Threads of the instance keep their provider session; switching device login and endpoint under them is refused.
            return yield* Effect.fail(
              new InstanceConflict("threads use this instance; add a new instance to connect another way"),
            );
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
  };
}

/** Deleting an instance and enabling it on workers. */
export function instanceMutations(
  sql: SqlClient.SqlClient,
  core: InstanceCore,
): Pick<InstanceApi, "remove" | "setWorkers" | "setWorker"> {
  const { workers, threadUse, lockInstance, putSecret, envFrom, assign, sync } = core;

  return {
    remove: ({ userId, request }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const harness = yield* harnessOrFail(request.harness);
          const row = yield* lockInstance(harness, request.id);

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
          yield* assign(harness, request.id, request.allWorkers, request.workerIds);

          return yield* sync(userId);
        }),
      ),
    setWorker: ({ userId, request }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const harness = yield* harnessOrFail(request.harness);
          const row = yield* lockInstance(harness, request.id);

          if (!(yield* workers()).some((w) => w.id === request.workerId))
            return yield* Effect.fail(new NotFound(`worker ${request.workerId} not found`));

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
  };
}
