import type { bots } from "@canopy/contracts";
import { isBotReactionEmoji } from "@canopy/domain/bot-reactions";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid, NotFound } from "../store/errors.ts";
import { enqueueReactionInput } from "./reaction-input.ts";
import type { BotAccess } from "./store-access.ts";
import { botReactionActor, type MessageRow } from "./store-views.ts";

const isUuid = Schema.is(Schema.String.check(Schema.isUUID()));

/** The caller holds the bot lock and commits this change with its tool result or owner input. */
export function setBotMessageReaction(
  sql: SqlClient.SqlClient,
  botId: string,
  messageId: string,
  actor: "user" | "bot",
  emoji: string,
  active: boolean,
) {
  return Effect.gen(function* () {
    if (!isBotReactionEmoji(emoji)) return yield* Effect.fail(new Invalid("Choose a supported reaction."));

    if (!isUuid(messageId)) return yield* Effect.fail(new Invalid("Choose a valid message."));

    const [target] = yield* sql<
      Pick<MessageRow, "bot_id" | "kind" | "sender_id" | "recipient_id" | "exchange_id" | "text" | "reactions">
    >`SELECT m.bot_id, m.kind, m.sender_id, m.recipient_id, m.exchange_id, m.text, m.reactions
      FROM bot_messages m JOIN bot_turns t ON t.id=m.turn_id AND t.bot_id=m.bot_id
      WHERE m.id=${messageId}::uuid AND m.bot_id=${botId}::uuid AND t.conversation_id IS NULL FOR UPDATE OF m`;

    if (!target || botReactionActor(target) !== actor)
      return yield* Effect.fail(new NotFound("No matching message from the other participant."));

    const changed = target.reactions.includes(emoji) !== active;

    if (changed) {
      const reactions = active ? [...target.reactions, emoji] : target.reactions.filter((value) => value !== emoji);
      yield* sql`UPDATE bot_messages SET reactions=${reactions}::text[] WHERE id=${messageId}::uuid`;
      yield* sql`UPDATE bots SET revision=revision+1 WHERE id=${botId}::uuid`;
    }

    return { changed, text: target.text };
  });
}

export function setUserBotMessageReaction(
  sql: SqlClient.SqlClient,
  access: BotAccess,
  owner: string,
  request: bots.SetBotMessageReactionRequest,
) {
  return sql.withTransaction(
    Effect.gen(function* () {
      const { botId, messageId, emoji, active } = request;

      if (!isUuid(botId)) return yield* Effect.fail(new Invalid("Choose a valid bot."));
      yield* access.requireEnabled(owner);
      yield* access.active(owner, botId, true);
      const { changed, text } = yield* setBotMessageReaction(sql, botId, messageId, "user", emoji, active);

      const steer = changed ? yield* enqueueReactionInput(sql, botId, messageId, emoji, active, text) : undefined;

      return { changed, steer };
    }),
  );
}
