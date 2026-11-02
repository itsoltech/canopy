import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ProfileModelsSchema, Provider, ui, type ModelInfo, type ProfileModels } from "@open-agents/contracts";
import { Context, Effect, Layer } from "effect";
import { SqlClient, type SqlError } from "effect/sql";

/**
 * Model catalogs of the workers (docs/ui-api.md, docs/protocol.md#modele-effort-i-steer): the last report
 * of each worker (ModelCatalog after a config, or ListModels), replaced as a whole.
 */

interface Row {
  worker_id: string;
  config_version: bigint | number;
  profiles: JsonValue;
  updated_at: Date;
}

export class ModelStore extends Context.Service<
  ModelStore,
  {
    save(input: { workerId: string; configVersion: bigint; profiles: readonly ProfileModels[] }): Effect.Effect<ui.WorkerModels, SqlError.SqlError>;
    /** Catalogs of the given workers (all workers when empty). */
    catalogs(workerIds: readonly string[]): Effect.Effect<ui.WorkerModels[], SqlError.SqlError>;
  }
>()("open-agents/gateway/ModelStore") {
  static readonly layer = Layer.effect(
    ModelStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const toUi = (row: Row) =>
        create(ui.WorkerModelsSchema, {
          workerId: row.worker_id,
          configVersion: BigInt(row.config_version),
          profiles: (row.profiles as JsonValue[]).map((p) => fromJson(ProfileModelsSchema, p, { ignoreUnknownFields: true })),
          updatedAt: timestampFromDate(new Date(row.updated_at)),
        });
      return ModelStore.of({
        save: ({ workerId, configVersion, profiles }) =>
          sql<Row>`
            INSERT INTO worker_model_catalogs (worker_id, config_version, profiles)
            VALUES (${workerId}::uuid, ${configVersion}, ${JSON.stringify(profiles.map((p) => toJson(ProfileModelsSchema, p)))}::jsonb)
            ON CONFLICT (worker_id) DO UPDATE SET config_version = EXCLUDED.config_version, profiles = EXCLUDED.profiles, updated_at = now()
            RETURNING *`.pipe(Effect.map((rows) => toUi(rows[0]!))),

        catalogs: (workerIds) =>
          (workerIds.length > 0
            ? sql<Row>`SELECT * FROM worker_model_catalogs WHERE worker_id = ANY(${workerIds}::uuid[]) ORDER BY worker_id`
            : sql<Row>`SELECT * FROM worker_model_catalogs ORDER BY worker_id`
          ).pipe(Effect.map((rows) => rows.map(toUi))),
      });
    }),
  );
}

/** The catalog entry a model id names (also by the model an alias resolves to); the default model for "". */
function findModel(catalog: ProfileModels, model: string): ModelInfo | undefined {
  return model ? catalog.models.find((m) => m.id === model || m.resolvedModel === model) : catalog.models.find((m) => m.isDefault);
}

/**
 * The effort a turn is started with (docs/protocol.md#modele-effort-i-steer). A model the catalog knows decides:
 * without efforts it gets none, an effort it does not offer falls back to its default effort (or none). An
 * unknown model (no catalog, a free-text id) keeps the effort as chosen; the worker has the final word.
 */
export function turnEffort(catalog: ProfileModels | undefined, model: string, effort: string): string {
  if (!effort || !catalog) return effort;
  const info = findModel(catalog, model);
  if (!info || info.efforts.includes(effort)) return effort;
  return info.efforts.includes(info.defaultEffort) ? info.defaultEffort : "";
}

/**
 * Checks a model and effort against a profile's catalog. Lenient where the catalog cannot tell: no catalog,
 * an incomplete one (detail), or a model without effort data passes.
 * Returns a problem for the user, or undefined.
 */
export function modelProblem(
  catalog: ProfileModels | undefined,
  provider: Provider,
  profileId: string,
  model: string,
  effort: string,
): string | undefined {
  if (model.length > 200 || effort.length > 40) return "model or effort is too long";
  if (effort && !/^[a-z][a-z0-9_-]*$/.test(effort)) return `invalid reasoning effort "${effort}"`;
  if (!catalog || catalog.detail || catalog.models.length === 0) return undefined;
  const name = provider === Provider.CLAUDE ? "Claude" : "Codex";
  const info = findModel(catalog, model);
  if (model && !info) return `${name} on profile "${profileId || "native"}" does not offer the model "${model}"`;
  if (effort && info && info.efforts.length > 0 && !info.efforts.includes(effort)) {
    return `${info.displayName || info.id} supports the reasoning efforts ${info.efforts.join(", ")}, not "${effort}"`;
  }
  return undefined;
}

/** Which models a profile shows in pickers (provider_model_selections); see applyModelSelections. */
export interface ModelSelectionRule {
  readonly profile_id: string;
  readonly provider: "claude" | "codex";
  readonly shown: readonly string[];
  readonly known: readonly string[];
  readonly show_new: boolean;
}

/**
 * The catalog as pickers see it (docs/protocol.md#modele-effort-i-steer, "Wybór modeli"): a profile with a selection
 * shows the models it lists, and a model the catalog did not have when the selection was saved only with show_new.
 * Models are marked hidden, never removed, so a thread on a hidden model still finds its name and efforts, and
 * the gateway's checks still accept it. Without a selection the catalog is unchanged (the provider's own hidden).
 */
export function applyModelSelections(catalog: ui.WorkerModels, rules: readonly ModelSelectionRule[]): ui.WorkerModels {
  if (rules.length === 0) return catalog;
  return create(ui.WorkerModelsSchema, {
    ...catalog,
    profiles: catalog.profiles.map((profile) => {
      const provider = profile.provider === Provider.CLAUDE ? "claude" : "codex";
      const rule = rules.find((r) => r.profile_id === (profile.profileId || "native") && r.provider === provider);
      if (!rule) return profile;
      const shown = new Set(rule.shown);
      const known = new Set(rule.known);
      return create(ProfileModelsSchema, {
        ...profile,
        models: profile.models.map((model) => ({ ...model, hidden: !(shown.has(model.id) || (!known.has(model.id) && rule.show_new)) })),
      });
    }),
  });
}
