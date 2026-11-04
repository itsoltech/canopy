import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  bots,
  connectors,
  MentionKind,
  MentionSchema,
  ProfileModelsSchema,
  Provider,
  type Mention,
  type ProfileModels,
  type ui,
} from "@canopy/contracts";
import { ConnectorFailure, connectorStore } from "../connectors/store.ts";
import { connectorType } from "../connectors/catalog.ts";
import { checkMentions, mentionPlaceholder, type JsonObject } from "@canopy/domain";
import { Context, Effect, Layer, Predicate } from "effect";
import { SqlClient } from "effect/sql";
import { decryptSecret } from "../store/secrets.ts";
import { Invalid, NotFound } from "../store/store.ts";
import { harnessOf, providerOf, type InstanceRow } from "../store/instance-config.ts";
import { checkedQuotes } from "../core/quotes.ts";
import { toUiQuote, type StoredQuote } from "../store/quotes.ts";
import { apiModel } from "./model.ts";
import { modelInput, storedMentions } from "./mentions.ts";
import { nextHop } from "./policy.ts";
import { proposedBot } from "./creation.ts";
import { originOf, routineStore, type RoutineOrigin } from "./routines.ts";
import { handoffStore } from "./handoffs.ts";
import type { BotRow, BotTurn, McpConnection, ModelMessage, StoredCall, ToolResult, ToolSpec } from "./types.ts";

export interface WakeupRow {
  id: string;
  prompt: string;
  run_at: Date;
  cancelled: boolean;
  delivered: boolean;
}

interface MessageRow {
  id: string;
  seq: bigint;
  bot_id: string;
  sender_id: string;
  recipient_id: string;
  kind: string;
  text: string;
  exchange_id: string | null;
  created_at: Date;
  message_key?: string;
  turn_status?: string;
  setting_changes?: bots.BotSettingChange[];
  mentions: JsonValue[];
  quotes: StoredQuote[];
}

interface ApprovalRow {
  id: string;
  bot_id: string;
  turn_id: string;
  kind: string;
  prompt: string;
  status: string;
  answer: string;
  created_at: Date;
  options?: unknown;
  proposed_bot: JsonValue | null;
  routine_title?: string;
}

export const botConfiguration = (row: BotRow) => fromJson(bots.BotConfigurationSchema, row.configuration);

export const botView = (row: BotRow) =>
  create(bots.BotSchema, {
    id: row.id,
    configuration: botConfiguration(row),
    createdAt: timestampFromDate(new Date(row.created_at)),
    updatedAt: timestampFromDate(new Date(row.updated_at)),
    archived: Boolean(row.archived_at),
    createdByBotId: row.created_by_bot_id ?? "",
    createdByBotName: row.created_by_bot_name,
    ownerUserId: row.owner_user_id,
    lastReadSeq: BigInt(row.last_read_seq),
    unreadCount: Number(row.unread_count ?? 0),
    movedFromName: row.move_notes?.from_name ?? "",
    reconnect: row.move_reconnect ?? [],
  });

/** A bot moved from a linked computer: its accounts and MCP servers not connected here yet (docs/linked-computers.md, stage 8). */
const MOVE_RECONNECT = `(SELECT coalesce(jsonb_agg(r), '[]'::jsonb) FROM jsonb_array_elements_text(coalesce(b.move_notes -> 'reconnect', '[]'::jsonb)) r
  WHERE NOT EXISTS (SELECT 1 FROM connector_accounts a WHERE a.owner_user_id = b.owner_user_id AND r = a.name || ' (' || a.connector_type || ')'
    AND (a.all_bots OR EXISTS (SELECT 1 FROM connector_bot_grants g WHERE g.account_id = a.id AND g.bot_id = b.id)))
    AND NOT EXISTS (SELECT 1 FROM bot_mcp_connections c JOIN bot_mcp_servers s ON s.id = c.server_id WHERE c.bot_id = b.id AND r = 'MCP server ' || s.name)) AS move_reconnect`;

const messageView = (row: MessageRow) =>
  create(bots.BotMessageSchema, {
    id: row.id,
    seq: BigInt(row.seq),
    botId: row.bot_id,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    kind: row.kind,
    text: row.text,
    exchangeId: row.exchange_id ?? "",
    createdAt: timestampFromDate(new Date(row.created_at)),
    failed: row.kind === "event" && row.message_key === "answer" && row.turn_status === "failed",
    settingChanges: row.setting_changes ?? [],
    mentions: storedMentions(row.mentions),
    quotes: row.quotes.map(toUiQuote),
  });

const approvalView = (row: ApprovalRow) =>
  create(bots.BotApprovalSchema, {
    id: row.id,
    botId: row.bot_id,
    turnId: row.turn_id,
    kind: row.kind,
    prompt: row.prompt,
    status: row.status,
    answer: row.answer,
    createdAt: timestampFromDate(new Date(row.created_at)),
    options: Array.isArray(row.options)
      ? row.options
          .filter((o): o is string => typeof o === "string" && o.trim() !== "")
          .slice(0, 6)
          .map((o) => o.slice(0, 200))
      : [],
    proposedBot: row.proposed_bot ? fromJson(bots.BotConfigurationSchema, row.proposed_bot) : undefined,
    routineTitle: row.routine_title ?? "",
  });

const uuid = () => Bun.randomUUIDv7();
export const MAX_BOTS_PER_USER = 50;

export function requiredString(args: JsonObject, key: string, max = 100_000): string {
  const value = args[key];

  if (!Predicate.isString(value) || !value.trim() || value.length > max)
    throw new Invalid(`${key} is required (at most ${max} characters)`);

  return value.trim();
}

export function remoteUrl(raw: string): string {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new Invalid("a remote http(s) URL is required");
  }

  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search)
    throw new Invalid("use an http(s) URL without credentials, query or fragment; put tokens in headers");

  // Connection definitions are explicit user input. Redirects are refused by the MCP client.
  return url.toString();
}

function makeStore(sql: SqlClient.SqlClient, key: Buffer) {
  const handoffs = handoffStore(sql);
  const connections = connectorStore(sql, key);

  const owned = (user: string, id: string, lock = false) =>
    sql
      .unsafe<BotRow>(
        `SELECT b.*, (SELECT count(*) FROM bot_messages m WHERE m.bot_id = b.id AND m.seq > b.last_read_seq AND m.sender_id = b.id::text AND m.recipient_id = 'user' AND m.kind = 'message') AS unread_count,
      ${MOVE_RECONNECT} FROM bots b WHERE b.id = $1::uuid AND b.owner_user_id = $2::uuid AND b.deleted_at IS NULL${lock ? " FOR UPDATE OF b" : ""}`,
        [id, user],
      )
      .pipe(Effect.flatMap((rows) => (rows[0] ? Effect.succeed(rows[0]) : Effect.fail(new NotFound("bot not found")))));

  const changed = (id: string) =>
    sql`UPDATE bots SET revision = revision + 1, updated_at = now() WHERE id = ${id}::uuid`;

  const active = (user: string, id: string, lock = false) =>
    owned(user, id, lock).pipe(
      Effect.flatMap((row) =>
        row.archived_at
          ? Effect.fail(new Invalid("this bot is archived; unarchive it first"))
          : // Frozen for a move to another computer (docs/linked-computers.md, stage 8): nothing new starts here.
            row.moved_to
            ? Effect.fail(new Invalid("this bot is moving to another computer"))
            : Effect.succeed(row),
      ),
    );

  const unpin = (
    user: string,
    id: string,
  ) => sql`UPDATE user_settings SET settings = jsonb_set(settings, '{sidebar,pinnedBotIds}',
    coalesce((SELECT jsonb_agg(v) FROM jsonb_array_elements_text(settings #> '{sidebar,pinnedBotIds}') v WHERE v <> ${id}), '[]'::jsonb)),
    version = version + 1, updated_at = now() WHERE user_id = ${user}::uuid AND settings #> '{sidebar,pinnedBotIds}' ? ${id}`;

  const stopTurns = (id: string) =>
    Effect.gen(function* () {
      yield* sql`UPDATE bot_turns SET status = 'interrupted', finished_at = now(), lease_token = NULL, lease_until = NULL WHERE bot_id = ${id}::uuid AND status IN ('queued','running','waiting')`;
      yield* sql`UPDATE bot_approvals SET status = 'discarded', answered_at = now() WHERE bot_id = ${id}::uuid AND status = 'pending'`;
      yield* sql`UPDATE bot_thread_watches SET delivered = true WHERE bot_id = ${id}::uuid AND NOT delivered`;
    });

  const fenced = (turn: BotTurn) =>
    Effect.gen(function* () {
      // Lifecycle operations and claim() lock bot -> turn. Writers must use that order too,
      // so an archive cannot deadlock with a checkpoint, self-edit or finishing response.
      const bot =
        yield* sql`SELECT id FROM bots WHERE id = ${turn.bot_id}::uuid AND deleted_at IS NULL AND archived_at IS NULL AND moved_to IS NULL FOR UPDATE`;

      if (!bot.length) return yield* Effect.fail(new Invalid("bot lease lost"));

      const rows =
        yield* sql<BotTurn>`SELECT * FROM bot_turns WHERE id = ${turn.id}::uuid AND lease_token = ${turn.lease_token}::uuid
      AND status = 'running' AND lease_until > now() FOR UPDATE`;

      return rows[0] ?? (yield* Effect.fail(new Invalid("bot lease lost")));
    });

  const secret = (user: string, id: string) =>
    sql<{
      ciphertext: Uint8Array;
    }>`SELECT ciphertext FROM secrets WHERE id = ${id}::uuid AND (owner_user_id = ${user}::uuid OR owner_user_id IS NULL)`.pipe(
      Effect.flatMap((r) =>
        r[0] ? Effect.succeed(decryptSecret(key, r[0].ciphertext)) : Effect.fail(new NotFound("secret not found")),
      ),
    );

  const server = (user: string, id: string) => connections.owned(user, id);

  const resolvedServer = (user: string, id: string) =>
    Effect.gen(function* () {
      const row = yield* server(user, id);
      const value = yield* connections.credentials(row);

      return { ...row, enabled: row.status === "connected", headers: value.headers ?? {} } satisfies McpConnection;
    });

  const servers = (user: string) =>
    Effect.gen(function* () {
      const rows = yield* connections.list(user);
      const result: bots.BotMcpServer[] = [];

      for (const row of rows.filter((r) => r.connector_type === "custom")) {
        const account = yield* connections.view(row);
        result.push(
          create(bots.BotMcpServerSchema, {
            id: row.id,
            name: row.name,
            url: row.url,
            transport: row.transport,
            enabled: row.status === "connected",
            headerNames: account.headerNames,
            botIds: account.botIds,
          }),
        );
      }

      return result;
    });

  const validate = (user: string, config: bots.BotConfiguration, requireCatalog = false) =>
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
        yield* sql<InstanceRow>`SELECT * FROM provider_instances WHERE harness = ${harnessOf(config.provider)} AND id = ${config.providerInstance} AND kind = 'endpoint'`;

      if (!instances[0])
        return yield* Effect.fail(
          new Invalid(
            "bots require a gateway-accessible endpoint provider instance; native CLI login is not supported",
          ),
        );

      for (const id of config.mcpServerIds) yield* server(user, id);
      const catalog = yield* catalogs(config);
      const model = apiModel(config.model, catalog, instances[0].custom_models);

      if ("problem" in model) return yield* Effect.fail(new Invalid(model.problem));

      if (
        requireCatalog &&
        !instances[0].custom_models.includes(model.model) &&
        !catalog.some((p) => p.models.some((m) => m.id === model.model || m.resolvedModel === model.model))
      )
        return yield* Effect.fail(
          new Invalid(
            "this provider instance has no matching API model in its catalog; use list_models or configure a custom model in Settings",
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

  /** What the workers last reported for the bot's instance (aliases and their concrete models). */
  const catalogs = (config: bots.BotConfiguration) =>
    sql<{ profiles: JsonValue[] }>`SELECT profiles FROM worker_model_catalogs`.pipe(
      Effect.map((rows): ProfileModels[] =>
        rows
          .flatMap((r) => r.profiles.map((p) => fromJson(ProfileModelsSchema, p, { ignoreUnknownFields: true })))
          .filter((p) => p.provider === config.provider && p.profileId === config.providerInstance),
      ),
    );

  /** The concrete API model of a saved bot; bots saved before validation may still name an alias. */
  const resolveModel = (config: bots.BotConfiguration) =>
    Effect.gen(function* () {
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

  const enqueue = (
    user: string,
    botId: string,
    input: string,
    requestId: string,
    options: RoutineOrigin & {
      hops?: number;
      sender?: string;
      replyTo?: string;
      exchangeId?: string;
      event?: boolean;
      mentions?: readonly Mention[];
      quotes?: readonly ui.Quote[];
    } = {},
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* active(user, botId, true);

        if (input.length > 100_000 || !requestId || requestId.length > 200)
          return yield* Effect.fail(new Invalid("valid text and client_request_id are required"));

        // A retry returns the original turn even if a mentioned bot was deleted since acceptance.
        const previous =
          (yield* sql<BotTurn>`SELECT * FROM bot_turns WHERE bot_id = ${botId}::uuid AND client_request_id = ${requestId}`)[0];

        if (previous) return previous.id;

        const quotes = yield* Effect.try({
          try: () => checkedQuotes(options.quotes ?? [], (message) => new Invalid(message)),
          catch: (cause) => (cause instanceof Invalid ? cause : new Invalid(String(cause))),
        });

        if (!input.trim() && quotes.length === 0) return yield* Effect.fail(new Invalid("text or quotes are required"));

        const mentions = yield* Effect.try({
          try: () => checkMentions(input, options.mentions ?? []),
          catch: (error) => new Invalid(error instanceof Error ? error.message : "invalid mentions"),
        });

        const checked: Mention[] = [];

        for (const mention of mentions) {
          if (input.slice(mention.start, mention.end) !== mentionPlaceholder(mention))
            return yield* Effect.fail(new Invalid("mention must have a matching @name range"));

          if (mention.kind === MentionKind.CONNECTOR) {
            const account = yield* connections
              .authorize({ userId: user, botId, accountId: mention.name })
              .pipe(
                Effect.mapError((error) =>
                  error instanceof ConnectorFailure ? new Invalid("Connector access denied") : error,
                ),
              );

            checked.push(
              create(MentionSchema, {
                kind: MentionKind.CONNECTOR,
                name: account.id,
                source: account.connector_type,
                label: `${connectorType(account.connector_type)?.name} · ${account.name}`,
                start: mention.start,
                end: mention.end,
              }),
            );
            continue;
          }

          if (mention.kind !== MentionKind.BOT || mention.name === botId)
            return yield* Effect.fail(new Invalid("only other bots or granted connectors can be mentioned"));
          const target = yield* active(user, mention.name);
          // Labels/paths from the client are never authority. Snapshot the owner's bot name for model context.
          checked.push(
            create(MentionSchema, {
              kind: MentionKind.BOT,
              name: target.id,
              label: botConfiguration(target).name,
              start: mention.start,
              end: mention.end,
            }),
          );
        }

        const turnId = uuid();

        const routine = options.routineId
          ? (yield* sql<{
              instructions: string;
            }>`SELECT instructions FROM bot_routines WHERE id = ${options.routineId}::uuid AND bot_id = ${botId}::uuid AND enabled AND deleted_at IS NULL`)[0]
          : undefined;

        if (options.routineId && !routine) return yield* Effect.fail(new Invalid("routine is disabled or deleted"));

        const storedInput = routine
          ? `Routine instructions (${options.routineTitle}):\n${routine.instructions}\n\n${input}`
          : input;

        yield* sql`INSERT INTO bot_turns(id, bot_id, client_request_id, input, hops, reply_to_bot_id, exchange_id, routine_id, routine_title)
      VALUES (${turnId}::uuid, ${botId}::uuid, ${requestId}, ${storedInput}, ${options.hops ?? 0}, ${options.replyTo ?? null}::uuid, ${options.exchangeId ?? null}::uuid, ${options.routineId ?? null}::uuid, ${options.routineTitle ?? ""})
      ON CONFLICT(bot_id, client_request_id) DO NOTHING`;

        const turn =
          (yield* sql<BotTurn>`SELECT * FROM bot_turns WHERE bot_id = ${botId}::uuid AND client_request_id = ${requestId}`)[0]!;

        if (!options.routineId)
          yield* sql`INSERT INTO bot_messages(id, bot_id, turn_id, message_key, sender_id, recipient_id, kind, text, exchange_id, mentions, quotes)
      VALUES (${uuid()}::uuid, ${botId}::uuid, ${turn.id}::uuid, 'input', ${options.sender ?? "user"}, ${botId}, ${options.event ? "event" : "message"}, ${input}, ${options.exchangeId ?? null}::uuid, ${JSON.stringify(checked.map((m) => toJson(MentionSchema, m)))}::jsonb, ${JSON.stringify(quotes)}::jsonb)
      ON CONFLICT(turn_id, message_key) DO NOTHING`;
        yield* changed(botId);

        return turn.id;
      }),
    );

  const finish = (turn: BotTurn, status: string, text: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* fenced(turn);
        const bot = (yield* sql<BotRow>`SELECT * FROM bots WHERE id = ${turn.bot_id}::uuid FOR UPDATE`)[0]!;

        if (text && !turn.routine_id && !turn.handoff_configuration)
          yield* sql`INSERT INTO bot_messages(id, bot_id, turn_id, message_key, sender_id, recipient_id, kind, text, exchange_id)
      VALUES (${uuid()}::uuid, ${turn.bot_id}::uuid, ${turn.id}::uuid, 'answer', ${turn.bot_id}, ${turn.reply_to_bot_id ?? turn.remote_recipient_ref ?? "user"}, ${status === "completed" ? "message" : "event"}, ${text}, ${turn.exchange_id}::uuid)
      ON CONFLICT(turn_id, message_key) DO NOTHING`;
        yield* sql`UPDATE bot_turns SET status = ${status}, lease_token = NULL, lease_until = NULL, finished_at = now() WHERE id = ${turn.id}::uuid`;
        yield* sql`UPDATE bots SET status_line = '', revision = revision + 1, updated_at = now() WHERE id = ${turn.bot_id}::uuid`;

        if (turn.routine_id) {
          const sent =
            yield* sql`SELECT id FROM bot_messages WHERE turn_id = ${turn.id}::uuid AND message_key LIKE 'user:%' LIMIT 1`;

          const acted =
            yield* sql`SELECT id FROM bot_tool_calls WHERE turn_id = ${turn.id}::uuid AND status = 'completed' AND tool ->> 'readOnly' <> 'true' AND NOT (result ? 'error') LIMIT 1`;

          yield* sql`UPDATE bot_routines SET last_outcome = ${status === "completed" ? (sent.length ? "Sent you a message" : acted.length ? "Completed background actions" : "Nothing to report") : `Run ${status}`}, updated_at = now() WHERE id = ${turn.routine_id}::uuid`;
        }

        if (status === "completed" && turn.reply_to_bot_id && text) {
          const target =
            yield* sql<BotRow>`SELECT * FROM bots WHERE id = ${turn.reply_to_bot_id}::uuid AND owner_user_id = ${bot.owner_user_id}::uuid AND deleted_at IS NULL AND archived_at IS NULL`;

          const source = turn.exchange_id
            ? (yield* sql<BotTurn>`SELECT t.* FROM bot_tool_calls c JOIN bot_turns t ON t.id = c.turn_id WHERE c.id = ${turn.exchange_id}::uuid`)[0]
            : undefined;

          if (target[0] && turn.hops < 8 && (yield* originEnabled(source)))
            yield* enqueue(
              bot.owner_user_id,
              turn.reply_to_bot_id,
              `Message from ${botConfiguration(bot).name}: ${text}`,
              `reply:${turn.id}`,
              {
                hops: nextHop(turn.hops),
                sender: turn.bot_id,
                exchangeId: turn.exchange_id!,
                event: true,
                ...originOf(source),
              },
            );
        }
      }),
    );

  const routines = routineStore(sql, { owned, changed, enqueue });

  const originEnabled = (turn: BotTurn | undefined) =>
    turn?.routine_id
      ? sql`SELECT id FROM bot_routines WHERE id = ${turn.routine_id}::uuid AND enabled AND deleted_at IS NULL`.pipe(
          Effect.map((r) => r.length > 0),
        )
      : Effect.succeed(true);

  return {
    handoffContext: handoffs.context,
    handoffFallback: handoffs.fallback,
    latestHandoff: handoffs.latest,
    finishHandoff: (turn: BotTurn, model: string, note: string, reason = "") =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* fenced(turn);
          yield* sql`INSERT INTO bot_handoff_notes(turn_id, bot_id, model, note, fallback_reason) VALUES (${turn.id}::uuid, ${turn.bot_id}::uuid, ${model}, ${note.slice(0, 32000)}, ${reason}) ON CONFLICT(turn_id) DO NOTHING`;
          yield* sql`UPDATE bot_turns SET status = 'completed', finished_at = now(), lease_token = NULL, lease_until = NULL WHERE id = ${turn.id}::uuid`;
          yield* sql`UPDATE bots SET status_line = '', revision = revision + 1 WHERE id = ${turn.bot_id}::uuid`;
        }),
      ),
    instanceLabel: (config: bots.BotConfiguration) =>
      sql<{
        label: string;
      }>`SELECT label FROM provider_instances WHERE harness = ${harnessOf(config.provider)} AND id = ${config.providerInstance}`.pipe(
        Effect.map((rows) => rows[0]?.label ?? config.providerInstance),
      ),
    owned,
    active,
    save,
    enqueue,
    finish,
    changed,
    fenced,
    servers,
    resolvedServer,
    resolveModel,
    ...routines,
    markRead: (user: string, id: string, throughSeq: bigint) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* owned(user, id, true);

          if (throughSeq < 0n || throughSeq > 9223372036854775807n)
            return yield* Effect.fail(new Invalid("invalid read sequence"));
          // A stale tab can only acknowledge messages it observed, never future messages.
          yield* sql`UPDATE bots SET last_read_seq = greatest(last_read_seq, least(${throughSeq}, coalesce((SELECT max(seq) FROM bot_messages WHERE bot_id = ${id}::uuid), 0))), revision = revision + 1 WHERE id = ${id}::uuid`;

          const latest =
            (yield* sql<MessageRow>`SELECT m.*, t.status AS turn_status FROM bot_messages m JOIN bot_turns t ON t.id = m.turn_id WHERE m.bot_id = ${id}::uuid ORDER BY m.seq DESC LIMIT 1`)[0];

          return create(bots.BotSchema, {
            ...botView(yield* owned(user, id)),
            lastMessage: latest ? messageView(latest) : undefined,
          });
        }),
      ),
    messageUser: (turn: BotTurn, call: StoredCall) =>
      Effect.gen(function* () {
        if (!turn.routine_id)
          return yield* Effect.fail(
            new Invalid("message_user is only available during background routines; reply normally in conversation"),
          );
        yield* sql`INSERT INTO bot_messages(id, bot_id, turn_id, message_key, sender_id, recipient_id, kind, text)
        VALUES (${uuid()}::uuid, ${turn.bot_id}::uuid, ${turn.id}::uuid, ${`user:${call.id}`}, ${turn.bot_id}, 'user', 'message', ${requiredString(call.arguments, "text")})
        ON CONFLICT(turn_id, message_key) DO NOTHING`;
        yield* changed(turn.bot_id);

        return { delivered: true };
      }),
    apiModels: (provider: Provider, instanceId: string) =>
      Effect.gen(function* () {
        const instance =
          (yield* sql<InstanceRow>`SELECT * FROM provider_instances WHERE harness = ${harnessOf(provider)} AND id = ${instanceId} AND kind = 'endpoint'`)[0];

        if (!instance) return yield* Effect.fail(new Invalid("choose a gateway-accessible endpoint provider instance"));

        const profiles = yield* catalogs(
          create(bots.BotConfigurationSchema, { provider, providerInstance: instanceId }),
        );

        const models = profiles
          .flatMap((p) => p.models)
          .filter((m) => !m.hidden)
          .flatMap((m) => {
            const resolved = apiModel(m.id, profiles, instance.custom_models);

            return "problem" in resolved
              ? []
              : [
                  {
                    id: resolved.model,
                    name: m.displayName || resolved.model,
                    default: m.isDefault,
                    efforts: m.efforts,
                    default_effort: m.defaultEffort,
                  },
                ];
          });

        for (const id of instance.custom_models)
          if (!models.some((m) => m.id === id))
            models.push({ id, name: id, default: false, efforts: [], default_effort: "" });

        return [...new Map(models.map((m) => [m.id, m])).values()];
      }),
    archive: (user: string, id: string, archived: boolean) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* owned(user, id, true);

          const row =
            (yield* sql<BotRow>`UPDATE bots SET archived_at = ${archived ? new Date() : null}, status_line = '', revision = revision + 1, updated_at = now() WHERE id = ${id}::uuid RETURNING *`)[0]!;

          if (archived) {
            yield* stopTurns(id);
            yield* unpin(user, id);
          }

          return botView(row);
        }),
      ),
    updateSelf: (user: string, turn: BotTurn, call: StoredCall) =>
      Effect.gen(function* () {
        const args = call.arguments;

        const fields = {
          name: "name",
          shape: "shape",
          color: "color",
          instructions: "instructions",
          model: "model",
          effort: "effort",
          provider_instance: "providerInstance",
          approval_policy: "approvalPolicy",
        } as const;

        const allowed = [...Object.keys(fields), "provider", "append_instructions"];
        const given = new Map<string, string>();

        for (const [key, value] of Object.entries(args))
          if (allowed.includes(key) && Predicate.isString(value)) given.set(key, value);

        if (!given.size || given.size !== Object.keys(args).length)
          return yield* Effect.fail(new Invalid("update_self accepts only your own supported setting fields"));

        if (Object.hasOwn(args, "instructions") && Object.hasOwn(args, "append_instructions"))
          return yield* Effect.fail(new Invalid("use instructions or append_instructions, not both"));

        if (
          ["model", "effort", "provider", "provider_instance", "approval_policy"].some((k) => Object.hasOwn(args, k))
        ) {
          const approved =
            yield* sql`SELECT id FROM bot_approvals WHERE id = ${call.id}::uuid AND bot_id = ${turn.bot_id}::uuid AND turn_id = ${turn.id}::uuid AND status = 'approved'`;

          if (!approved.length)
            return yield* Effect.fail(new Invalid("changing model, effort or approval policy requires user approval"));
        }

        const row = yield* owned(user, turn.bot_id, true);
        const before = botConfiguration(row);
        const next = create(bots.BotConfigurationSchema, { ...before });

        for (const [arg, field] of Object.entries(fields)) {
          const value = given.get(arg);

          if (value !== undefined) next[field] = value;
        }

        const provider = given.get("provider");
        const appended = given.get("append_instructions");

        if (provider !== undefined) {
          if (!["claude", "codex", "grok"].includes(provider))
            return yield* Effect.fail(new Invalid("unknown provider"));
          next.provider = providerOf(provider);
        }

        if (appended !== undefined) next.instructions = [before.instructions, appended].filter(Boolean).join("\n");
        const saved = (yield* save(user, next, { id: turn.bot_id })).configuration!;

        const labels = [
          ["name", "name"],
          ["shape", "shape"],
          ["color", "colour"],
          ["instructions", "instructions"],
          ["model", "model"],
          ["effort", "reasoning effort"],
          ["providerInstance", "provider instance"],
          ["approvalPolicy", "approval policy"],
          ["provider", "provider"],
        ] as const satisfies readonly (readonly [keyof bots.BotConfiguration, string])[];

        const changes = labels.flatMap(([field, label]) => {
          const previous = String(before[field] ?? "");
          const after = String(saved[field] ?? "");

          return previous === after ? [] : [{ field: label, before: previous, after }];
        });

        const text = changes
          .map((c) =>
            c.field === "name"
              ? `${before.name} changed its name to ${c.after}`
              : `${saved.name} updated its ${c.field}`,
          )
          .join(". ");

        if (changes.length)
          yield* sql`INSERT INTO bot_messages(id, bot_id, turn_id, message_key, sender_id, recipient_id, kind, text)
        VALUES (${uuid()}::uuid, ${turn.bot_id}::uuid, ${turn.id}::uuid, ${`self:${call.id}`}, 'self', 'user', 'event', ${text})
        ON CONFLICT(turn_id, message_key) DO NOTHING`;

        return { updated: true, changes };
      }),
    createFromBot: (user: string, turn: BotTurn, call: StoredCall) =>
      Effect.gen(function* () {
        yield* creationHop(turn.hops);
        const creator = yield* active(user, turn.bot_id);

        const approved =
          (yield* sql<ApprovalRow>`SELECT * FROM bot_approvals WHERE id = ${call.id}::uuid AND bot_id = ${turn.bot_id}::uuid AND turn_id = ${turn.id}::uuid AND status = 'approved'`)[0];

        let proposal = approved?.proposed_bot
          ? fromJson(bots.BotConfigurationSchema, approved.proposed_bot)
          : undefined;

        // Full auto: no card was shown, so validate the proposal here exactly as the card would have.
        if (!proposal && botConfiguration(creator).approvalPolicy === "full_auto") {
          const draft = yield* Effect.try({
            try: () => proposedBot(call.arguments, botConfiguration(creator)),
            catch: (error) => (error instanceof Invalid ? error : new Invalid("invalid bot configuration")),
          });

          proposal = yield* validate(user, draft, true);
        }

        if (!proposal)
          return yield* Effect.fail(new Invalid("creating a bot requires user approval of its configuration"));
        const saved = yield* save(user, proposal, { requestId: call.id });
        yield* sql`UPDATE bots SET created_by_bot_id = ${creator.id}::uuid, created_by_bot_name = ${botConfiguration(creator).name} WHERE id = ${saved.id}::uuid`;

        return { id: saved.id, name: saved.configuration!.name };
      }),
    list: (user: string, includeArchived = false) =>
      Effect.gen(function* () {
        const rows = yield* sql.unsafe<BotRow>(
          `SELECT b.*, (SELECT count(*) FROM bot_messages m WHERE m.bot_id = b.id AND m.seq > b.last_read_seq AND m.sender_id = b.id::text AND m.recipient_id = 'user' AND m.kind = 'message') AS unread_count,
        ${MOVE_RECONNECT} FROM bots b WHERE b.owner_user_id = $1::uuid AND b.deleted_at IS NULL AND ($2 OR b.archived_at IS NULL) ORDER BY b.created_at, b.id`,
          [user, includeArchived],
        );

        const latest =
          yield* sql<MessageRow>`SELECT DISTINCT ON(m.bot_id) m.*, t.status AS turn_status FROM bot_messages m JOIN bots b ON b.id = m.bot_id JOIN bot_turns t ON t.id = m.turn_id
        WHERE b.owner_user_id = ${user}::uuid AND b.deleted_at IS NULL ORDER BY m.bot_id, m.seq DESC`;

        const byBot = new Map(latest.map((m) => [m.bot_id, messageView(m)]));

        return rows.map((r) => create(bots.BotSchema, { ...botView(r), lastMessage: byBot.get(r.id) }));
      }),
    remove: (user: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* owned(user, id, true);
          yield* sql`UPDATE bots SET deleted_at = now(), status_line = '', revision = revision + 1 WHERE id = ${id}::uuid`;
          yield* stopTurns(id);
          yield* unpin(user, id);
          yield* sql`UPDATE bot_wakeups SET cancelled = true WHERE bot_id = ${id}::uuid`;
        }),
      ),
    conversation: (user: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          // Taking the bot lock synchronizes snapshot revisions with all conversation writers.
          const bot = yield* owned(user, id, true);

          const messages =
            yield* sql<MessageRow>`SELECT m.*, t.status AS turn_status, c.result -> 'changes' AS setting_changes
        FROM bot_messages m JOIN bot_turns t ON t.id = m.turn_id LEFT JOIN bot_tool_calls c ON m.message_key = 'self:' || c.id::text
        WHERE m.bot_id = ${id}::uuid ORDER BY m.seq`;

          // A question's options are the arguments of its ask_user call (the approval id is the call id).
          const approvals =
            yield* sql<ApprovalRow>`SELECT a.*, t.routine_title, CASE WHEN a.kind = 'question' THEN c.arguments -> 'options' END AS options
        FROM bot_approvals a JOIN bot_turns t ON t.id = a.turn_id LEFT JOIN bot_tool_calls c ON c.id = a.id WHERE a.bot_id = ${id}::uuid ORDER BY a.created_at, a.id`;

          const active =
            yield* sql`SELECT id FROM bot_turns WHERE bot_id = ${id}::uuid AND handoff_configuration IS NULL AND status IN ('queued','running','waiting') AND (routine_id IS NULL OR status = 'waiting') LIMIT 1`;

          const reminders = yield* sql<{
            id: string;
            prompt: string;
            run_at: Date;
          }>`SELECT id, prompt, run_at FROM bot_wakeups WHERE bot_id = ${id}::uuid AND NOT delivered AND NOT cancelled ORDER BY run_at`;

          return create(bots.BotConversationSchema, {
            bot: create(bots.BotSchema, {
              ...botView(bot),
              lastMessage: messages.length ? messageView(messages.at(-1)!) : undefined,
            }),
            messages: messages.map(messageView),
            approvals: approvals.map(approvalView),
            statusLine: active.length ? bot.status_line : "",
            working: active.length > 0,
            revision: BigInt(bot.revision),
            routines: yield* routines.routines(user, id),
            reminders: reminders.map((r) =>
              create(bots.BotReminderSchema, {
                id: r.id,
                prompt: r.prompt,
                runAt: timestampFromDate(new Date(r.run_at)),
              }),
            ),
          });
        }),
      ),
    exchange: (user: string, id: string) =>
      sql<MessageRow>`SELECT m.* FROM bot_messages m JOIN bots b ON b.id = m.bot_id JOIN bot_turns t ON t.id = m.turn_id
      WHERE m.exchange_id = ${id}::uuid AND b.owner_user_id = ${user}::uuid AND b.deleted_at IS NULL AND (t.reply_to_bot_id IS NOT NULL OR t.remote_recipient_ref IS NOT NULL) AND m.message_key IN ('input','answer') ORDER BY m.seq`.pipe(
        Effect.map((r) => r.map(messageView)),
      ),
    history: (turn: BotTurn) =>
      sql<MessageRow>`SELECT * FROM (SELECT m.*, t.created_at AS turn_created, t.id AS turn_order FROM bot_messages m JOIN bot_turns t ON t.id = m.turn_id
      WHERE m.bot_id = ${turn.bot_id}::uuid AND m.sender_id <> 'self' AND (${Boolean(turn.handoff_configuration)} OR (t.created_at, t.id) <= (SELECT created_at, id FROM bot_turns WHERE id = ${turn.id}::uuid))
      ORDER BY t.created_at DESC, t.id DESC, m.seq DESC LIMIT ${turn.routine_id ? 60 : 2147483647}) recent ORDER BY turn_created, turn_order, seq`.pipe(
        Effect.map((rows): ModelMessage[] => [
          ...rows.map((r): ModelMessage => ({
            role: r.sender_id === turn.bot_id ? "assistant" : "user",
            text: modelInput(r.text, storedMentions(r.mentions), r.quotes),
          })),
          ...(turn.routine_id || turn.handoff_configuration ? [{ role: "user" as const, text: turn.input }] : []),
        ]),
      ),
    claim: (user: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          // Handoff is a configuration barrier ahead of queued work, but never preempts a live lease.
          const rows = yield* sql<BotRow & { next_turn_id: string }>`SELECT b.*, t.id AS next_turn_id FROM bots b
        CROSS JOIN LATERAL (SELECT * FROM bot_turns WHERE bot_id = b.id AND status IN ('queued','running','waiting')
          ORDER BY CASE WHEN status = 'running' AND lease_until > now() THEN 0 WHEN handoff_configuration IS NOT NULL THEN 1 ELSE 2 END, created_at, id LIMIT 1) t
        WHERE b.deleted_at IS NULL AND b.archived_at IS NULL AND b.owner_user_id = ${user}::uuid
          AND t.status IN ('queued','running') AND (t.lease_until IS NULL OR t.lease_until <= now())
        ORDER BY b.updated_at FOR UPDATE OF b SKIP LOCKED LIMIT 1`;

          if (!rows[0]) return undefined;
          const id = rows[0].id;
          const token = uuid();

          const turns =
            yield* sql<BotTurn>`UPDATE bot_turns SET status = 'running', lease_token = ${token}::uuid, lease_until = now() + interval '30 seconds'
        WHERE id = ${rows[0].next_turn_id}::uuid RETURNING *`;

          const turn = turns[0]!;
          // A remote side effect may already have happened. Never repeat it after a crash.
          yield* sql`UPDATE bot_tool_calls SET status = 'interrupted', result = '{"error":"interrupted: gateway restarted during remote call; outcome unknown; do not retry without user confirmation"}'::jsonb WHERE turn_id = ${turn.id}::uuid AND status = 'running' AND (tool ->> 'source' = 'mcp' OR linked_remote)`;
          yield* sql`UPDATE bots SET status_line = ${turn.routine_id || turn.handoff_configuration ? "" : "Typing…"}, revision = revision + 1 WHERE id = ${id}::uuid`;

          return turn;
        }),
      ),
    heartbeat: (turn: BotTurn) =>
      sql`UPDATE bot_turns SET lease_until = now() + interval '30 seconds' WHERE id = ${turn.id}::uuid AND lease_token = ${turn.lease_token}::uuid AND status = 'running' AND lease_until > now() RETURNING id`.pipe(
        Effect.map((r) => r.length > 0),
      ),
    status: (turn: BotTurn, text: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* fenced(turn);

          if (!turn.routine_id && !turn.handoff_configuration)
            yield* sql`UPDATE bots SET status_line = ${text}, revision = revision + 1 WHERE id = ${turn.bot_id}::uuid`;
        }),
      ),
    checkpoint: (turn: BotTurn, messages: ModelMessage[]) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* fenced(turn);
          yield* sql`UPDATE bot_turns SET checkpoint = ${JSON.stringify(messages)}::jsonb WHERE id = ${turn.id}::uuid`;
        }),
      ),
    planCall: (turn: BotTurn, callKey: string, tool: ToolSpec, args: JsonObject) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* fenced(turn);
          yield* sql`INSERT INTO bot_tool_calls(id, turn_id, call_key, tool, arguments) VALUES (${uuid()}::uuid, ${turn.id}::uuid, ${callKey}, ${JSON.stringify(tool)}::jsonb, ${JSON.stringify(args)}::jsonb) ON CONFLICT(turn_id, call_key) DO NOTHING`;

          return (yield* sql<StoredCall>`SELECT * FROM bot_tool_calls WHERE turn_id = ${turn.id}::uuid AND call_key = ${callKey}`)[0]!;
        }),
      ),
    call: (turn: BotTurn, id: string) =>
      sql<StoredCall>`SELECT * FROM bot_tool_calls WHERE id = ${id}::uuid AND turn_id = ${turn.id}::uuid`.pipe(
        Effect.map((r) => r[0]!),
      ),
    // A platform effect and its result commit together; the lease row is held until commit.
    action: <A, E, R>(turn: BotTurn, call: StoredCall, effect: Effect.Effect<A, E, R>) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* fenced(turn);

          const saved =
            (yield* sql<StoredCall>`SELECT * FROM bot_tool_calls WHERE id = ${call.id}::uuid FOR UPDATE`)[0]!;

          if (saved.status === "completed" || saved.status === "interrupted") {
            // SAFETY: a completed call stores this same action's earlier result (in its JSON form); a replay returns
            // it instead of running the action twice.
            return saved.result as A;
          }

          const result = yield* effect;
          yield* sql`UPDATE bot_tool_calls SET status = 'completed', result = ${JSON.stringify(result ?? null)}::jsonb WHERE id = ${call.id}::uuid`;

          return result;
        }),
      ),
    remoteStarted: (turn: BotTurn, call: StoredCall, linked = false) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* fenced(turn);
          yield* sql`UPDATE bot_tool_calls SET status = 'running', linked_remote = ${linked} WHERE id = ${call.id}::uuid AND status = 'pending'`;
        }),
      ),
    remoteResult: (turn: BotTurn, call: StoredCall, result: ToolResult) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* fenced(turn);
          // A platform action may have committed before its post-commit dispatch failed.
          // Its durable result wins over a later transport error or stale executor result.
          yield* sql`UPDATE bot_tool_calls SET status = 'completed', result = ${JSON.stringify(result)}::jsonb WHERE id = ${call.id}::uuid AND status NOT IN ('completed','interrupted')`;

          return (yield* sql<StoredCall>`SELECT * FROM bot_tool_calls WHERE id = ${call.id}::uuid`)[0]!.result;
        }),
      ),
    approval: (turn: BotTurn, call: StoredCall, prompt: string, question: boolean) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* fenced(turn);
          const previous = (yield* sql<ApprovalRow>`SELECT * FROM bot_approvals WHERE id = ${call.id}::uuid`)[0];

          if (previous) return approvalView(previous);
          let proposal: JsonValue | null = null;

          if (call.tool.source === "platform" && call.tool.name === "create_bot") {
            yield* creationHop(turn.hops);
            const creator = (yield* sql<BotRow>`SELECT * FROM bots WHERE id = ${turn.bot_id}::uuid`)[0]!;

            const draft = yield* Effect.try({
              try: () => proposedBot(call.arguments, botConfiguration(creator)),
              catch: (error) => (error instanceof Invalid ? error : new Invalid("invalid bot configuration")),
            });

            const config = yield* validate(creator.owner_user_id, draft, true);
            proposal = toJson(bots.BotConfigurationSchema, config);
            // Keep a prose fallback for clients predating the structured preview.
            prompt = [
              `Needs approval · Creating bot “${config.name}”`,
              `Name: ${config.name}`,
              `Model: ${config.model}`,
              `Effort: ${config.effort || "Model default"}`,
              `Instance: ${config.provider === Provider.CLAUDE ? "Claude" : "Codex"} · ${config.providerInstance}`,
              `Approval policy: ${config.approvalPolicy}`,
              `Instructions: ${config.instructions || "No additional instructions."}`,
            ].join("\n");
          }

          yield* sql`INSERT INTO bot_approvals(id, bot_id, turn_id, kind, prompt, proposed_bot) VALUES (${call.id}::uuid, ${turn.bot_id}::uuid, ${turn.id}::uuid, ${question ? "question" : "approval"}, ${prompt}, ${JSON.stringify(proposal)}::jsonb) ON CONFLICT(id) DO NOTHING`;

          return approvalView((yield* sql<ApprovalRow>`SELECT * FROM bot_approvals WHERE id = ${call.id}::uuid`)[0]!);
        }),
      ),
    wait: (turn: BotTurn) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* fenced(turn);

          // Serialize with answer(): an answer cannot arrive between this check and the wait state.
          const pending =
            yield* sql`SELECT id FROM bot_approvals WHERE turn_id = ${turn.id}::uuid AND status = 'pending' FOR UPDATE`;

          yield* sql`UPDATE bot_turns SET status = ${pending.length ? "waiting" : "queued"}, lease_token = NULL, lease_until = NULL WHERE id = ${turn.id}::uuid`;
          yield* sql`UPDATE bots SET status_line = ${pending.length ? "Waiting for you" : turn.routine_id ? "" : "Typing…"}, revision = revision + 1 WHERE id = ${turn.bot_id}::uuid`;
        }),
      ),
    answer: (user: string, request: bots.AnswerBotApprovalRequest) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const candidates =
            yield* sql<ApprovalRow>`SELECT a.* FROM bot_approvals a JOIN bots b ON b.id = a.bot_id WHERE a.id = ${request.approvalId}::uuid AND b.owner_user_id = ${user}::uuid AND b.deleted_at IS NULL`;

          if (!candidates[0]) return yield* Effect.fail(new NotFound("approval not found"));
          yield* owned(user, candidates[0].bot_id, true);
          // Same turn -> approval lock order as wait().
          yield* sql`SELECT id FROM bot_turns WHERE id = ${candidates[0].turn_id}::uuid FOR UPDATE`;

          const row =
            (yield* sql<ApprovalRow>`SELECT * FROM bot_approvals WHERE id = ${request.approvalId}::uuid FOR UPDATE`)[0]!;

          if (row.status !== "pending") return approvalView(row);

          if (request.answer.length > 32_000) return yield* Effect.fail(new Invalid("answer too long"));

          const updated =
            (yield* sql<ApprovalRow>`UPDATE bot_approvals SET status = ${request.approve ? "approved" : "discarded"}, answer = ${request.answer}, answered_at = now() WHERE id = ${row.id}::uuid RETURNING *`)[0]!;

          yield* sql`UPDATE bot_turns SET status = 'queued' WHERE id = ${row.turn_id}::uuid AND status = 'waiting'`;
          yield* changed(row.bot_id);

          return approvalView(updated);
        }),
      ),
    interrupt: (user: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* owned(user, id, true);
          yield* sql`UPDATE bot_turns SET status = 'interrupted', lease_token = NULL, lease_until = NULL, finished_at = now() WHERE id = (SELECT id FROM bot_turns WHERE bot_id = ${id}::uuid AND handoff_configuration IS NULL AND status IN ('running','waiting','queued') ORDER BY created_at, id LIMIT 1)`;
          yield* sql`UPDATE bot_approvals SET status = 'discarded', answered_at = now() WHERE bot_id = ${id}::uuid AND status = 'pending' AND turn_id IN (SELECT id FROM bot_turns WHERE status = 'interrupted')`;
          yield* sql`UPDATE bots SET status_line = '', revision = revision + 1 WHERE id = ${id}::uuid`;
        }),
      ),
    retry: (user: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* active(user, id, true);

          const last = (yield* sql<{
            id: string;
            status: string;
          }>`SELECT id, status FROM bot_turns WHERE bot_id = ${id}::uuid AND handoff_configuration IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`)[0];

          if (last?.status !== "failed")
            return yield* Effect.fail(new Invalid("only a failed last reply can be retried"));
          // The failure note goes; the same input runs again from its checkpoint.
          yield* sql`DELETE FROM bot_messages WHERE turn_id = ${last.id}::uuid AND message_key = 'answer' AND kind = 'event'`;
          yield* sql`UPDATE bot_turns SET status = 'queued', finished_at = NULL, lease_token = NULL, lease_until = NULL WHERE id = ${last.id}::uuid`;
          yield* changed(id);
        }),
      ),
    release: (turn: BotTurn) =>
      sql`UPDATE bot_turns SET lease_until = now(), lease_token = NULL WHERE id = ${turn.id}::uuid AND lease_token = ${turn.lease_token}::uuid`,
    provider: (user: string, config: bots.BotConfiguration) =>
      Effect.gen(function* () {
        const instance =
          (yield* sql<InstanceRow>`SELECT * FROM provider_instances WHERE harness = ${harnessOf(config.provider)} AND id = ${config.providerInstance} AND kind = 'endpoint'`)[0];

        if (!instance) return yield* Effect.fail(new Invalid("provider endpoint unavailable"));

        return { url: instance.base_url, key: instance.api_key ? yield* secret(user, instance.api_key.secretRef) : "" };
      }),
    connected: (user: string, botId: string) =>
      Effect.gen(function* () {
        yield* owned(user, botId);
        const links = (yield* connections.list(user, { botId })).filter((r) => r.status === "connected");
        const result: McpConnection[] = [];

        for (const l of links) result.push(yield* resolvedServer(user, l.id));

        return result;
      }),
    saveServer: (user: string, request: bots.SaveBotMcpServerRequest) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const old = request.id ? yield* server(user, request.id) : undefined;

          const account = yield* connections.save(
            user,
            create(connectors.SaveConnectorAccountRequestSchema, {
              id: request.id,
              connectorType: "custom",
              name: request.name,
              url: request.url,
              transport: request.transport,
              authKind: "headers",
              headers: request.headers,
              replaceCredentials: request.clearHeaders,
              expectedRevision: old ? BigInt(old.revision) : 0n,
            }),
          );

          const id = account.id;

          if (!request.enabled) yield* connections.status(yield* server(user, id), "disconnected");

          return (yield* servers(user)).find((s) => s.id === id)!;
        }),
      ),
    deleteServer: (user: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* server(user, id);
          yield* connections.disconnect(user, id);
          yield* sql`DELETE FROM connector_bot_grants WHERE account_id=${id}::uuid`;
          // Keep public configuration consistent with the normalized connection relation.
          yield* sql`UPDATE bots SET configuration = jsonb_set(configuration, '{mcpServerIds}', coalesce((SELECT jsonb_agg(v) FROM jsonb_array_elements_text(coalesce(configuration -> 'mcpServerIds', '[]')) v WHERE v <> ${id}), '[]')), revision = revision + 1 WHERE owner_user_id = ${user}::uuid`;
        }),
      ),
    sendToBot: (user: string, turn: BotTurn, call: StoredCall) =>
      Effect.gen(function* () {
        const target = requiredString(call.arguments, "bot_id", 100);

        if (target === turn.bot_id) return yield* Effect.fail(new Invalid("choose another bot"));
        const hops = nextHop(turn.hops);
        nextHop(hops); // reserve the reply's hop, like notify in the agent bus
        const sender = yield* owned(user, turn.bot_id);
        const recipient = yield* active(user, target);
        yield* enqueue(
          user,
          target,
          `Message from ${botConfiguration(sender).name}: ${requiredString(call.arguments, "text")}`,
          `bot:${call.id}`,
          { hops, sender: turn.bot_id, replyTo: turn.bot_id, exchangeId: call.id, event: true },
        );
        yield* sql`INSERT INTO bot_messages(id, bot_id, turn_id, message_key, sender_id, recipient_id, kind, text, exchange_id)
        VALUES (${uuid()}::uuid, ${turn.bot_id}::uuid, ${turn.id}::uuid, ${call.id}, ${turn.bot_id}, ${target}, 'event', ${`Messaged ${botConfiguration(recipient).name}`}, ${call.id}::uuid) ON CONFLICT(turn_id, message_key) DO NOTHING`;
        yield* changed(sender.id);

        return { bot_id: target, exchange_id: call.id, status: "queued" };
      }),
    watchThread: (turn: BotTurn, call: StoredCall, threadId: string, turnId: string) =>
      Effect.gen(function* () {
        const hop = nextHop(turn.hops);
        const replyHop = nextHop(hop);
        yield* sql`UPDATE turns SET trigger = 'bot', author_user_id = NULL, bot_call_id = ${call.id}::uuid, hops = ${hop} WHERE id = ${turnId}::uuid AND status = 'queued'`;
        yield* sql`INSERT INTO bot_thread_watches(call_id, bot_id, target_thread_id, target_turn_id, hops)
        VALUES (${call.id}::uuid, ${turn.bot_id}::uuid, ${threadId}::uuid, ${turnId}::uuid, ${replyHop}) ON CONFLICT(call_id) DO NOTHING`;
      }),
    watchSteer: (turn: BotTurn, call: StoredCall, threadId: string, steerId: string) =>
      Effect.gen(function* () {
        const hops = nextHop(turn.hops);
        const replyHops = nextHop(hops);
        yield* sql`UPDATE turn_steers SET bot_call_id = ${call.id}::uuid, author_user_id = NULL, hops = ${hops} WHERE id = ${steerId}::uuid`;
        yield* sql`INSERT INTO bot_thread_watches(call_id, bot_id, target_thread_id, target_steer_id, hops)
        VALUES (${call.id}::uuid, ${turn.bot_id}::uuid, ${threadId}::uuid, ${steerId}::uuid, ${replyHops}) ON CONFLICT(call_id) DO NOTHING`;
      }),
    wakeup: (turn: BotTurn, call: StoredCall) =>
      Effect.gen(function* () {
        const runAt = new Date(requiredString(call.arguments, "run_at", 100));

        if (!Number.isFinite(runAt.getTime()) || runAt.getTime() <= Date.now())
          return yield* Effect.fail(new Invalid("run_at must be in the future"));
        yield* sql`INSERT INTO bot_wakeups(id, bot_id, prompt, run_at, hops) VALUES (${call.id}::uuid, ${turn.bot_id}::uuid, ${requiredString(call.arguments, "prompt")}, ${runAt}, ${nextHop(turn.hops)}) ON CONFLICT(id) DO NOTHING`;
        yield* changed(turn.bot_id);

        return { schedule_id: call.id };
      }),
    wakeups: (botId: string) =>
      sql<WakeupRow>`SELECT id, prompt, run_at, cancelled, delivered FROM bot_wakeups WHERE bot_id = ${botId}::uuid ORDER BY run_at`,
    cancelReminder: (user: string, botId: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* owned(user, botId, true);

          const r =
            yield* sql`UPDATE bot_wakeups SET cancelled = true WHERE id = ${id}::uuid AND bot_id = ${botId}::uuid AND NOT delivered RETURNING id`;

          if (!r.length) return yield* Effect.fail(new NotFound("reminder not found"));
          yield* changed(botId);
        }),
      ),
    cancelWakeup: (botId: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const r =
            yield* sql`UPDATE bot_wakeups SET cancelled = true WHERE id = ${id}::uuid AND bot_id = ${botId}::uuid RETURNING id`;

          yield* changed(botId);

          return { cancelled: r.length > 0 };
        }),
      ),
    deliver: () =>
      sql.withTransaction(
        Effect.gen(function* () {
          const steers = yield* sql<{
            call_id: string;
            target_turn_id: string;
          }>`SELECT w.call_id, CASE WHEN s.status = 'delivered' THEN s.turn_id ELSE s.queued_turn_id END AS target_turn_id
        FROM bot_thread_watches w JOIN turn_steers s ON w.target_steer_id = s.id JOIN bots b ON b.id = w.bot_id
        WHERE NOT w.delivered AND w.target_turn_id IS NULL AND s.status IN ('delivered','queued') AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL FOR UPDATE OF b, w SKIP LOCKED`;

          for (const steer of steers)
            yield* sql`UPDATE bot_thread_watches SET target_turn_id = ${steer.target_turn_id}::uuid WHERE call_id = ${steer.call_id}::uuid`;

          const watches = yield* sql<{
            call_id: string;
            bot_id: string;
            target_thread_id: string;
            target_turn_id: string;
            hops: number;
            owner_user_id: string;
            status: string;
            title: string;
          }>`SELECT w.*, b.owner_user_id, t.status, th.title FROM bot_thread_watches w
        JOIN bots b ON b.id = w.bot_id JOIN turns t ON t.id = w.target_turn_id JOIN threads th ON th.id = t.thread_id
        WHERE NOT w.delivered AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL AND th.owner_user_id = b.owner_user_id AND t.status IN ('completed','failed','interrupted','cancelled') FOR UPDATE OF b, w SKIP LOCKED`;

          for (const watch of watches) {
            const items = yield* sql<{
              content: { agentMessage?: { text?: string } };
            }>`SELECT content FROM thread_items WHERE thread_id = ${watch.target_thread_id}::uuid AND turn_id = ${watch.target_turn_id}::uuid ORDER BY first_seq`;

            const text = items
              .map((i) => i.content.agentMessage?.text ?? "")
              .filter(Boolean)
              .join("\n")
              .slice(0, 80_000);

            const source =
              (yield* sql<BotTurn>`SELECT t.* FROM bot_tool_calls c JOIN bot_turns t ON t.id = c.turn_id WHERE c.id = ${watch.call_id}::uuid`)[0];

            if (yield* originEnabled(source))
              yield* enqueue(
                watch.owner_user_id,
                watch.bot_id,
                `Thread ${watch.title} (${watch.target_thread_id}) ended: ${watch.status}.\n${text}`,
                `thread:${watch.call_id}`,
                { hops: watch.hops, sender: watch.target_thread_id, event: true, ...originOf(source) },
              );
            yield* sql`UPDATE bot_thread_watches SET delivered = true WHERE call_id = ${watch.call_id}::uuid`;
          }

          const wakeups = yield* sql<{
            id: string;
            bot_id: string;
            prompt: string;
            hops: number;
            owner_user_id: string;
          }>`SELECT w.*, b.owner_user_id FROM bot_wakeups w JOIN bots b ON b.id = w.bot_id
        WHERE NOT w.delivered AND NOT w.cancelled AND w.run_at <= now() AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL FOR UPDATE OF b, w SKIP LOCKED`;

          for (const wake of wakeups) {
            const source =
              (yield* sql<BotTurn>`SELECT t.* FROM bot_tool_calls c JOIN bot_turns t ON t.id = c.turn_id WHERE c.id = ${wake.id}::uuid`)[0];

            if (yield* originEnabled(source))
              yield* enqueue(wake.owner_user_id, wake.bot_id, wake.prompt, `wakeup:${wake.id}`, {
                hops: wake.hops,
                sender: "system",
                event: true,
                ...originOf(source),
              });
            yield* sql`UPDATE bot_wakeups SET delivered = true WHERE id = ${wake.id}::uuid`;
            yield* changed(wake.bot_id);
          }
        }),
      ),
  };
}

export class BotStore extends Context.Service<BotStore, ReturnType<typeof makeStore>>()("canopy/gateway/BotStore") {
  static readonly layer = (key: Buffer) =>
    Layer.effect(
      BotStore,
      Effect.gen(function* () {
        return makeStore(yield* SqlClient.SqlClient, key);
      }),
    );
}
