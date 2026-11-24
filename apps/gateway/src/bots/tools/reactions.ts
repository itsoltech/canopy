import { botReactionOptions } from "@canopy/domain/bot-reactions";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { requireOwnerBotTurn } from "../owner-turn.ts";
import { setBotMessageReaction } from "../store-reactions.ts";
import { BotStore } from "../store.ts";
import { bool, define, object, str } from "./shared.ts";

export const reactToMessage = define(
  "react_to_message",
  "Add an emoji reaction to a message from your owner in this private chat. Use the Owner message ID supplied with their input or the message_id in history. Set active=false to remove your reaction. Use reactions occasionally. When a brief acknowledgment like OK is all the message needs, react and finish the turn without additional text.",
  object({ message_id: str, emoji: { type: "string", enum: botReactionOptions.map((r) => r.emoji) }, active: bool }, [
    "message_id",
    "emoji",
  ]),
  "Reacting to your message",
  (c) => {
    const messageId = c.string("message_id");
    const emoji = c.string("emoji");
    const active = c.flag("active") ?? true;

    return c.options.runtime.runPromise(
      BotStore.use((s) =>
        s.action(
          c.turn,
          c.call,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* requireOwnerBotTurn(sql, c.options.userId, c.turn, "Reactions require a private owner message.");
            const { changed } = yield* setBotMessageReaction(sql, c.turn.bot_id, messageId, "bot", emoji, active);

            return { message_id: messageId, emoji, active, changed };
          }),
        ),
      ),
    );
  },
);
