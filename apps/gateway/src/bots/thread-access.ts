import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid } from "../store/errors.ts";
import { lockedBotThreadConnection, BOT_THREADS_DISCONNECTED } from "../store/module-access.ts";
import { threadToolNames } from "./thread-tools.ts";
import type { StoredCall } from "./types.ts";

/** Serialize a thread mutation or approval with disabling the modules, even on an owner's first settings write. */
export function authorizeThreadAction(sql: SqlClient.SqlClient, botId: string, call: StoredCall) {
  return Effect.gen(function* () {
    const name = call.tool.name;

    if (call.tool.source !== "platform" || (!threadToolNames.has(name) && name !== "cancel_schedule")) return;

    const bot = (yield* sql<{ owner_user_id: string }>`SELECT owner_user_id FROM bots WHERE id = ${botId}::uuid`)[0];

    if (!bot) return yield* Effect.fail(new Invalid("Bot not found"));

    if (yield* lockedBotThreadConnection(sql, bot.owner_user_id)) return;

    if (name === "cancel_schedule" && call.arguments["scope"] !== "platform") {
      const own = yield* sql`SELECT id FROM bot_wakeups WHERE bot_id = ${botId}::uuid
        AND id::text = ${String(call.arguments["schedule_id"])}`;

      if (own.length) return;
    }

    return yield* Effect.fail(new Invalid(BOT_THREADS_DISCONNECTED));
  });
}
