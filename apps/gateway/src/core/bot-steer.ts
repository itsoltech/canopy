import { lockModuleAdmission } from "../store/module-access.ts";
import { activeChannelTurn, lockChannelAccount } from "../messengers/conversation-access.ts";
import { coreState } from "./core-context.ts";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { BotStore } from "../bots/store.ts";
import type { BotSteerDelivery } from "../bots/types.ts";
import type { GatewayCore } from "./core.ts";

const steerResult = Schema.decodeUnknownSync(
  Schema.Struct({ status: Schema.Literals(["delivered", "queued", "unsupported"]) }),
);

/** Acceptance of this transient command still requires confirmation from the worker journal. */
export async function deliverBotSteer(core: GatewayCore, { workerId, ...input }: BotSteerDelivery): Promise<boolean> {
  const { runtime, userId } = core[coreState].options;

  const delivery = await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lockModuleAdmission(sql, userId);

          if (!(yield* BotStore.use((s) => s.harnessAuthorized(userId, workerId, input.botId, input.turnId))))
            return undefined;

          const [turn] = yield* sql<{ conversation_id: string | null }>`
            SELECT conversation_id FROM bot_turns WHERE id=${input.turnId}::uuid`;

          if (turn?.conversation_id) {
            yield* lockChannelAccount(sql, turn.conversation_id);

            if (!(yield* activeChannelTurn(sql, input.turnId))) return undefined;

            const context =
              yield* sql`SELECT 1 FROM bot_channel_conversations c JOIN bot_channel_routes r ON r.id=c.route_id
              WHERE c.id=${turn.conversation_id}::uuid AND r.channel_context AND c.channel_id=ANY(r.channel_ids)`;

            if (context.length) return undefined;
          }

          const connection = core.link.connections.get(workerId);

          if (!connection?.isOpen || !connection.hello.capabilities.includes("bot_steer_v1")) return undefined;
          // Hand off before deletion can commit. The ACK can arrive after the transaction ends.
          const pending = connection.sendCommand({ case: "steerBotTurn", value: input }, 10_000, input.inputId);

          void pending.catch(() => {});

          return { pending };
        }),
      );
    }),
  );

  if (!delivery) return false;

  const result = await delivery.pending;

  return result.ok && (!result.dataJson || steerResult(JSON.parse(result.dataJson)).status !== "unsupported");
}
