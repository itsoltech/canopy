import { lockModuleAdmission } from "../store/module-access.ts";
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
