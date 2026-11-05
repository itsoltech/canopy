import { create } from "@bufbuild/protobuf";
import { ProviderProfileKind, ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { enabledOn, modelsRule, providerOf, type InstanceRow, type StoredOverrides } from "./instance-config.ts";
import { Invalid, NotFound } from "./store.ts";
import { MAX_MODELS, checkBaseUrl, harnessOrFail, report, type InstanceApi } from "./instance-checks.ts";
import type { InstanceCore } from "./instance-queries.ts";
import { configTransaction, recordProviders } from "../config-sync/provider-records.ts";

/** Model choices, the per-worker view and endpoints registered by the CLI. */
export function instanceModels(
  sql: SqlClient.SqlClient,
  core: InstanceCore,
): Pick<InstanceApi, "setModels" | "sync" | "workerInstances" | "modelRules" | "registerEndpoint"> {
  const { instances, assignments, workers, sync } = core;

  return {
    setModels: (request) =>
      configTransaction(
        sql,
        Effect.gen(function* () {
          const harness = yield* harnessOrFail(request.harness);
          const models = request.models;

          const lists = [models?.favorites ?? [], models?.hidden ?? [], models?.shown ?? [], models?.custom ?? []].map(
            (l) => [...new Set(l.map((m) => m.trim()).filter(Boolean))],
          );

          const [favorites = [], hidden = [], shown = [], custom = []] = lists;

          if (lists.some((l) => l.length > MAX_MODELS) || lists.flat().some((m) => m.length > 200 || /\s/.test(m)))
            return yield* Effect.fail(new Invalid("invalid model list"));

          if (custom.length > 100) return yield* Effect.fail(new Invalid("at most 100 custom models"));

          if (request.favoritesOnly) {
            const updated =
              yield* sql`UPDATE provider_instances SET favorites = ${favorites}::text[], updated_at = now() WHERE harness = ${harness} AND id = ${request.id} RETURNING id`;

            if (updated.length === 0)
              return yield* Effect.fail(new NotFound(`provider instance ${harness}/${request.id} not found`));

            return;
          }

          const rows = yield* sql`
                UPDATE provider_instances
                   SET favorites = ${favorites}::text[], hidden_models = ${hidden}::text[], shown_models = ${shown}::text[], custom_models = ${custom}::text[], updated_at = now()
                 WHERE harness = ${harness} AND id = ${request.id} RETURNING id`;

          if (rows.length === 0)
            return yield* Effect.fail(new NotFound(`provider instance ${harness}/${request.id} not found`));
        }).pipe(Effect.tap(() => recordProviders(sql))),
      ),
    sync: (userId, workerIds) => configTransaction(sql, sync(userId, workerIds)),
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

                const assignment = rows.find(
                  (a) => a.harness === row.harness && a.instance_id === row.id && a.worker_id === w.id,
                );

                return create(ui.WorkerInstanceSchema, {
                  harness: provider,
                  id: row.id,
                  label: row.label,
                  accentColor: row.accent_color,
                  enabled: enabledOn(row, assignment),
                  available: reported?.available ?? false,
                  detail: reported ? reported.detail : "not reported by the worker yet",
                  favorites: row.favorites,
                  kind:
                    assignment?.proxy_id || row.kind === "endpoint"
                      ? ProviderProfileKind.CLIPROXYAPI
                      : ProviderProfileKind.NATIVE,
                });
              }),
            ] as const;
          }),
        );
      }),
    modelRules: () => instances().pipe(Effect.map((rows) => rows.map(modelsRule))),
    registerEndpoint: ({ userId, workerId, baseUrl, apiKey }) =>
      configTransaction(
        sql,
        Effect.gen(function* () {
          const problem = checkBaseUrl(baseUrl);

          if (problem) return yield* Effect.fail(new Invalid(problem));

          for (const harness of ["claude", "codex", "grok"] as const) {
            const found =
              (yield* sql<InstanceRow>`SELECT * FROM provider_instances WHERE harness = ${harness} AND id = 'cliproxyapi' FOR UPDATE`)[0];

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

          yield* recordProviders(sql);
        }),
      ),
  };
}
