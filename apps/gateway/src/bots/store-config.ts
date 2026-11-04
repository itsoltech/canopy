import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { bots, Provider, ProfileModelsSchema, type ProfileModels } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { Invalid } from "../store/store.ts";
import { harnessOf, type InstanceRow } from "../store/instance-config.ts";
import { apiModel } from "./model.ts";
import { nextHop } from "./policy.ts";
import type { BotRow } from "./types.ts";
import { MAX_BOTS_PER_USER, botConfiguration, botView, uuid } from "./store-views.ts";
import type { BotAccess } from "./store-access.ts";

/** Checks a bot configuration against its instance, catalog, connectors and mentions. */
function botValidate(
  sql: SqlClient.SqlClient,
  { server }: Pick<BotAccess, "server">,
  catalogs: (config: bots.BotConfiguration) => Effect.Effect<ProfileModels[], SqlError.SqlError>,
) {
  return (user: string, config: bots.BotConfiguration, requireCatalog = false) =>
    Effect.gen(function* () {
      if (
        !config.name.trim() ||
        config.name.length > 80 ||
        // oxlint-disable-next-line no-control-regex -- a bot name is one line of visible text
        /[\x00-\x1f\x7f]/.test(config.name) ||
        ![
          "round",
          "cloud",
          "diamond",
          "spark",
          "clover",
          "blob",
          "flower",
          "droplet",
          "pill",
          "triangle",
          "square",
          "star",
          "hexagon",
          "pumpkin",
        ].includes(config.shape) ||
        !/^#[0-9a-f]{6}$/i.test(config.color)
      )
        return yield* Effect.fail(new Invalid("a name, known mascot shape and #rrggbb color are required"));

      if (
        !harnessOf(config.provider) ||
        !config.model ||
        config.model.length > 200 ||
        config.effort.length > 40 ||
        config.instructions.length > 32_000
      )
        return yield* Effect.fail(new Invalid("invalid bot model configuration"));

      if (
        !["safe", "always", "full_auto", ""].includes(config.approvalPolicy) ||
        config.mcpServerIds.length > 32 ||
        new Set(config.mcpServerIds).size !== config.mcpServerIds.length
      )
        return yield* Effect.fail(new Invalid("invalid approval policy or MCP connections"));

      const instances =
        yield* sql<InstanceRow>`SELECT * FROM provider_instances WHERE harness = ${harnessOf(config.provider)} AND id = ${config.providerInstance}`;

      if (!instances[0]) return yield* Effect.fail(new Invalid("choose an existing provider instance"));

      // Grok keeps the direct gateway runtime until its ACP adapter lands in stage 2.
      if (config.provider === Provider.GROK && instances[0].kind !== "endpoint")
        return yield* Effect.fail(new Invalid("Grok bots require a gateway-accessible endpoint provider instance"));

      if (config.workerId) {
        const workers =
          yield* sql`SELECT w.id FROM workers w JOIN provider_instances i ON i.harness = ${harnessOf(config.provider)} AND i.id = ${config.providerInstance}
          LEFT JOIN provider_instance_workers a ON a.worker_id = w.id AND a.harness = i.harness AND a.instance_id = i.id
          WHERE w.id::text = ${config.workerId} AND (w.owner_user_id = ${user}::uuid OR w.owner_user_id IS NULL) AND w.revoked_at IS NULL AND w.archived_at IS NULL
          AND coalesce(a.enabled, i.all_workers)`;

        if (!workers.length)
          return yield* Effect.fail(new Invalid("choose a worker with this provider instance enabled"));
      }

      for (const id of config.mcpServerIds) yield* server(user, id);
      const catalog = yield* catalogs(config);

      const model =
        config.provider === Provider.GROK
          ? apiModel(config.model, catalog, instances[0].custom_models)
          : { model: config.model };

      if ("problem" in model) return yield* Effect.fail(new Invalid(model.problem));

      if (
        (requireCatalog || catalog.some((p) => p.models.length > 0)) &&
        !instances[0].custom_models.includes(model.model) &&
        !catalog.some((p) => p.models.some((m) => m.id === model.model || m.resolvedModel === model.model))
      )
        return yield* Effect.fail(
          new Invalid(
            "this provider instance has no matching model in its worker catalog; use list_models or configure a custom model in Settings",
          ),
        );

      const efforts = catalog
        .flatMap((p) => p.models)
        .filter((m) => m.id === config.model || m.id === model.model || m.resolvedModel === model.model)
        .flatMap((m) => m.efforts);

      if (config.effort && efforts.length && !efforts.includes(config.effort))
        return yield* Effect.fail(new Invalid("this model does not offer that effort"));

      return create(bots.BotConfigurationSchema, {
        ...config,
        model: model.model,
        name: config.name.trim().normalize("NFC"),
        color: config.color.toLowerCase(),
        approvalPolicy: config.approvalPolicy || "safe",
      });
    });
}

/** Bot configurations: validation, the concrete model and saving. */
export function botConfig(sql: SqlClient.SqlClient, access: BotAccess) {
  const { handoffs, owned, server } = access;

  /** What the workers last reported for the bot's instance (aliases and their concrete models). */
  const catalogs = (config: bots.BotConfiguration) =>
    sql<{
      profiles: JsonValue[];
    }>`SELECT profiles FROM worker_model_catalogs WHERE (${config.workerId || null}::uuid IS NULL OR worker_id = ${config.workerId || null}::uuid)`.pipe(
      Effect.map((rows): ProfileModels[] =>
        rows
          .flatMap((r) => r.profiles.map((p) => fromJson(ProfileModelsSchema, p, { ignoreUnknownFields: true })))
          .filter((p) => p.provider === config.provider && p.profileId === config.providerInstance),
      ),
    );

  const validate = botValidate(sql, { server }, catalogs);

  /** The concrete API model of a saved bot; bots saved before validation may still name an alias. */
  const resolveModel = (config: bots.BotConfiguration) =>
    Effect.gen(function* () {
      if (config.provider !== Provider.GROK) return { model: config.model };

      const instance =
        (yield* sql<InstanceRow>`SELECT * FROM provider_instances WHERE harness = ${harnessOf(config.provider)} AND id = ${config.providerInstance} AND kind = 'endpoint'`)[0];

      return apiModel(config.model, yield* catalogs(config), instance?.custom_models ?? []);
    });

  const save = (user: string, config: bots.BotConfiguration, options: { id?: string; requestId?: string }) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const before = options.id ? botConfiguration(yield* owned(user, options.id, true)) : undefined;
        // Serialize names per owner, including concurrent create/update/self-edit requests.
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${user}, 0))`;

        // Idempotent creates must keep succeeding even when the owner has since reached the cap.
        if (!options.id && options.requestId) {
          const previous =
            (yield* sql<BotRow>`SELECT * FROM bots WHERE owner_user_id = ${user}::uuid AND client_request_id = ${options.requestId}`)[0];

          if (previous)
            return previous.deleted_at
              ? yield* Effect.fail(new Invalid("create request refers to a deleted bot"))
              : botView(previous);
        }

        const checked = yield* validate(user, config, !options.id);

        const existing = yield* sql<{
          name: string;
        }>`SELECT configuration ->> 'name' AS name FROM bots WHERE owner_user_id = ${user}::uuid AND deleted_at IS NULL
      AND id <> ${options.id ?? "00000000-0000-0000-0000-000000000000"}::uuid
      AND (${options.requestId ?? null}::text IS NULL OR client_request_id <> ${options.requestId ?? null})`;

        // Use the wizard's exact Unicode/case comparison, independent of the database locale.
        if (existing.some((row) => row.name.trim().normalize("NFC").toLowerCase() === checked.name.toLowerCase()))
          return yield* Effect.fail(new Invalid("another bot already has that name"));
        const id = options.id ?? uuid();
        let row: BotRow;

        if (options.id) {
          yield* owned(user, id, true);

          const rows =
            yield* sql<BotRow>`UPDATE bots SET configuration = ${JSON.stringify(toJson(bots.BotConfigurationSchema, checked))}::jsonb,
        provider = ${harnessOf(checked.provider)}, provider_instance = ${checked.providerInstance}, updated_at = now(), revision = revision + 1 WHERE id = ${id}::uuid RETURNING *`;

          row = rows[0]!;
        } else {
          if (!options.requestId || options.requestId.length > 200)
            return yield* Effect.fail(new Invalid("client_request_id is required"));

          const count = (yield* sql<{
            count: number;
          }>`SELECT count(*)::int AS count FROM bots WHERE owner_user_id = ${user}::uuid AND deleted_at IS NULL`)[0]!
            .count;

          if (count >= MAX_BOTS_PER_USER)
            return yield* Effect.fail(
              new Invalid(
                `bot limit reached (${MAX_BOTS_PER_USER} per user, including archived bots); delete a bot before creating another`,
              ),
            );
          yield* sql`INSERT INTO bots(id, owner_user_id, client_request_id, configuration, provider, provider_instance)
        VALUES (${id}::uuid, ${user}::uuid, ${options.requestId}, ${JSON.stringify(toJson(bots.BotConfigurationSchema, checked))}::jsonb,
          ${harnessOf(checked.provider)}, ${checked.providerInstance}) ON CONFLICT(owner_user_id, client_request_id) DO NOTHING`;
          row =
            (yield* sql<BotRow>`SELECT * FROM bots WHERE owner_user_id = ${user}::uuid AND client_request_id = ${options.requestId} AND deleted_at IS NULL`)[0]!;

          if (!row) return yield* Effect.fail(new Invalid("create request refers to a deleted bot"));
        }

        // A repeated create returns the original definition rather than modifying its connections.
        const active = botConfiguration(row);

        if (before) yield* handoffs.enqueue(row.id, before, active);

        // Unrelated bot settings saves never reset grants configured on connector accounts.
        if (
          (!before && row.id === id) ||
          (before && JSON.stringify(before.mcpServerIds) !== JSON.stringify(active.mcpServerIds))
        ) {
          yield* sql`DELETE FROM connector_bot_grants WHERE bot_id=${row.id}::uuid AND account_id IN (SELECT id FROM connector_accounts WHERE connector_type='custom' AND NOT all_bots)`;

          for (const serverId of active.mcpServerIds)
            yield* sql`INSERT INTO connector_bot_grants(bot_id,account_id) VALUES (${row.id}::uuid,${serverId}::uuid) ON CONFLICT DO NOTHING`;
        }

        return botView(row);
      }),
    );

  const creationHop = (hops: number) =>
    Effect.try({
      try: () => nextHop(hops),
      catch: () => new Invalid("Bot hop limit reached; a new user message is required"),
    });

  return { catalogs, validate, resolveModel, save, creationHop };
}
