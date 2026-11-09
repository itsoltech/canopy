import { create, toBinary, toJson } from "@bufbuild/protobuf";
import { bots, MentionKind, MentionSchema, type Mention, type ui } from "@canopy/contracts";
import { ConnectorFailure } from "../connectors/store.ts";
import { connectorType } from "../connectors/catalog.ts";
import { checkMentions, mentionPlaceholder, type AttachmentLimits } from "@canopy/domain";
import { botImages, storedBotImage } from "./attachments.ts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { Invalid } from "../store/store.ts";
import { checkedQuotes } from "../core/quotes.ts";
import { nextHop } from "./policy.ts";
import { originOf, routineStore, type RoutineOrigin } from "./routines.ts";
import type { BotRow, BotTurn } from "./types.ts";
import { botConfiguration, uuid } from "./store-views.ts";
import type { BotAccess } from "./store-access.ts";
import type { botConfig } from "./store-config.ts";

/** Queues a bot turn with its message (user, bot, routine or system input). */
function botEnqueue(
  sql: SqlClient.SqlClient,
  { active, changed, connections }: Pick<BotAccess, "active" | "changed" | "connections">,
) {
  return (
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
      displayText?: string;
      mentions?: readonly Mention[];
      quotes?: readonly ui.Quote[];
      attachmentIds?: readonly string[];
      attachmentLimits?: AttachmentLimits | undefined;
      draftRevision?: bigint | undefined;
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

        const images = yield* botImages(sql, user, options.attachmentIds ?? [], options.attachmentLimits);
        const files = new Map(images.map((a) => [a.id, a]));

        if (!input.trim() && quotes.length === 0 && !images.length)
          return yield* Effect.fail(new Invalid("Write a message or attach an image."));

        const mentions = yield* Effect.try({
          try: () => checkMentions(input, options.mentions ?? []),
          catch: (error) => new Invalid(error instanceof Error ? error.message : "invalid mentions"),
        });

        const checked: Mention[] = [];

        for (const mention of mentions) {
          if (input.slice(mention.start, mention.end) !== mentionPlaceholder(mention))
            return yield* Effect.fail(new Invalid("mention must have a matching @name range"));

          if (mention.kind === MentionKind.ATTACHMENT) {
            const image = files.get(mention.name);

            if (!image) return yield* Effect.fail(new Invalid("This image is unavailable. Upload it again."));
            checked.push(create(MentionSchema, { ...mention, label: image.name, source: "image", path: "" }));
            continue;
          }

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

        for (const image of images)
          yield* sql`UPDATE attachments SET bot_id=${botId}::uuid, bot_turn_id=${turn.id}::uuid
            WHERE id=${image.id}::uuid AND thread_id IS NULL AND bot_id IS NULL`;

        if (options.draftRevision !== undefined)
          yield* sql`UPDATE bot_composer_drafts SET payload=${toBinary(bots.BotComposerDraftSchema, create(bots.BotComposerDraftSchema))}, revision=revision+1
            WHERE bot_id=${botId}::uuid AND owner_user_id=${user}::uuid AND revision=${options.draftRevision}`;

        if (!options.routineId)
          yield* sql`INSERT INTO bot_messages(id, bot_id, turn_id, message_key, sender_id, recipient_id, kind, text, exchange_id, mentions, quotes, attachments)
      VALUES (${uuid()}::uuid, ${botId}::uuid, ${turn.id}::uuid, 'input', ${options.sender ?? "user"}, ${botId}, ${options.event ? "event" : "message"}, ${options.displayText ?? input}, ${options.exchangeId ?? null}::uuid, ${JSON.stringify(checked.map((m) => toJson(MentionSchema, m)))}::jsonb, ${JSON.stringify(quotes)}::jsonb, ${JSON.stringify(images.map(storedBotImage))}::jsonb)
      ON CONFLICT(turn_id, message_key) DO NOTHING`;
        yield* changed(botId);

        return turn.id;
      }),
    );
}

/** The turn queue: enqueue, finish (with replies to other bots) and routines. */
export function botQueue(sql: SqlClient.SqlClient, access: BotAccess) {
  const { changed, fenced, owned } = access;
  const enqueue = botEnqueue(sql, access);

  const finish = (turn: BotTurn, status: string, text: string, errorCode = "", errorSource = "") =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* fenced(turn);
        const bot = (yield* sql<BotRow>`SELECT * FROM bots WHERE id = ${turn.bot_id}::uuid FOR UPDATE`)[0]!;

        if (text && !turn.routine_id && !turn.handoff_configuration)
          yield* sql`INSERT INTO bot_messages(id, bot_id, turn_id, message_key, sender_id, recipient_id, kind, text, exchange_id, error_code, error_source)
      VALUES (${uuid()}::uuid, ${turn.bot_id}::uuid, ${turn.id}::uuid, 'answer', ${turn.bot_id}, ${turn.reply_to_bot_id ?? turn.remote_recipient_ref ?? "user"}, ${status === "completed" ? "message" : "event"}, ${text}, ${turn.exchange_id}::uuid, ${errorCode}, ${errorSource})
      ON CONFLICT(turn_id, message_key) DO NOTHING`;
        yield* sql`UPDATE bot_turns SET status = ${status}, lease_token = NULL, lease_until = NULL, finished_at = now() WHERE id = ${turn.id}::uuid`;
        yield* sql`UPDATE bot_approvals SET status = 'expired', answered_at = now() WHERE turn_id = ${turn.id}::uuid AND status = 'pending'`;
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

  return { enqueue, finish, routines, originEnabled };
}

export type BotCore = BotAccess & ReturnType<typeof botConfig> & ReturnType<typeof botQueue>;
