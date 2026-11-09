import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { coreState } from "./core-context.ts";
import { NotFound, SteerStore, toUiSteer, toUiTurn } from "../store/index.ts";
import { coreRun } from "./core-broadcast.ts";
import type { GatewayCore } from "./core.ts";

/** Serialize admission and its receipt across retries, even if a turn ends during the first send. */
export async function messageReceipt(
  core: GatewayCore,
  request: ui.SendMessageRequest,
  apply: () => Promise<{ turn?: ui.Turn; steer?: ui.Steer; goal?: ui.Goal }>,
) {
  const { actions, options } = core[coreState];

  return actions.transaction(async () => {
    const receipt = await actions.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        const owned = yield* sql`SELECT id FROM threads WHERE id=${request.threadId}::uuid
          AND owner_user_id=${options.userId}::uuid FOR UPDATE`;

        if (!owned.length) return yield* Effect.fail(new NotFound("thread not found"));

        return yield* sql<{ response: Uint8Array }>`SELECT response FROM thread_message_receipts
          WHERE thread_id=${request.threadId}::uuid AND client_request_id=${request.clientRequestId}`;
      }),
    );

    if (request.clientRequestId && receipt[0]) {
      const result = fromBinary(ui.SendMessageResponseSchema, receipt[0].response);

      // The receipt fixes admission, while delivery/execution can advance after the response was lost.
      if (result.steer) {
        const steer = await actions.run(
          SteerStore.use((s) => s.byClientRequest(request.threadId, request.clientRequestId)),
        );

        if (steer) return { steer: toUiSteer(steer) };
      }

      if (result.turn) {
        const turn = await coreRun(core, (s) => s.turnByClientRequest(request.threadId, request.clientRequestId));

        if (turn) return { turn: toUiTurn(turn) };
      }

      return {
        ...(result.turn && { turn: result.turn }),
        ...(result.steer && { steer: result.steer }),
        ...(result.goal && { goal: result.goal }),
      };
    }

    const response = await apply();

    if (request.clientRequestId)
      await actions.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO thread_message_receipts(thread_id,client_request_id,response)
            VALUES(${request.threadId}::uuid,${request.clientRequestId},${toBinary(ui.SendMessageResponseSchema, create(ui.SendMessageResponseSchema, response))})`;
        }),
      );

    return response;
  });
}
