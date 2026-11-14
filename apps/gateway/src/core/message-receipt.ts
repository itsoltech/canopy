import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { coreState } from "./core-context.ts";
import { NotFound, SteerStore, toUiSteer, toUiTurn } from "../store/index.ts";
import { coreRun } from "./core-broadcast.ts";
import type { GatewayCore } from "./core.ts";

export interface MessageResponse {
  turn?: ui.Turn;
  steer?: ui.Steer;
  goal?: ui.Goal;
}

/** The thread columns a message's checks depend on, read with the admission lock. */
export interface AdmissionState {
  worker_id: string | null;
  cwd: string | null;
  provider: string;
  provider_profile_id: string | null;
  model: string;
  archived: boolean;
  deleted: boolean;
  rewind_pending_id: string | null;
  import_mode: string | null;
}

/**
 * Checks first, without a lock or a held connection. Then one short transaction locks the thread, checks the
 * receipt and commits the admission with its receipt. Worker and linked delivery follow the commit (outbox),
 * so retries replay the admission even if a turn ends during the first send (docs/threads.md).
 */
export async function messageReceipt<P extends { replay?: MessageResponse | undefined }>(
  core: GatewayCore,
  request: ui.SendMessageRequest,
  send: { prepare: () => Promise<P>; admit: (prepared: P, state: AdmissionState) => Promise<MessageResponse> },
): Promise<MessageResponse> {
  const { actions } = core[coreState];
  let prepared: P;

  try {
    prepared = await send.prepare();
  } catch (error) {
    // A retry of an admitted message (e.g. to a thread archived since) replays it; another owner gets NotFound.
    const { replay } = await receipt(core, request, false);

    if (replay) return replay;
    throw error;
  }

  if (prepared.replay) return prepared.replay;

  return actions.transaction(async () => {
    const { replay, state } = await receipt(core, request, true);

    if (replay) return replay;
    const response = await send.admit(prepared, state);

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

/** The owner's thread (locked for admission): its admission state and the replay of a stored receipt. */
async function receipt(
  core: GatewayCore,
  request: ui.SendMessageRequest,
  lock: boolean,
): Promise<{ replay?: MessageResponse; state: AdmissionState }> {
  const { actions, options } = core[coreState];

  const { state, response } = await actions.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const owned = yield* sql<AdmissionState>`SELECT t.worker_id,t.cwd,t.provider,t.provider_profile_id,
        coalesce(t.settings->>'model','') AS model,t.archived_at IS NOT NULL AS archived,
        t.deleted_at IS NOT NULL AS deleted,t.rewind_pending_id,
        (SELECT ti.mode FROM thread_imports ti WHERE ti.thread_id=t.id) AS import_mode
        FROM threads t WHERE id=${request.threadId}::uuid AND owner_user_id=${options.userId}::uuid
        ${lock ? sql`FOR UPDATE` : sql``}`;

      if (!owned.length) return yield* Effect.fail(new NotFound("thread not found"));

      // A separate statement: its snapshot follows the lock, so it sees a receipt committed while this waited.
      const stored = request.clientRequestId
        ? yield* sql<{ response: Uint8Array }>`SELECT response FROM thread_message_receipts
          WHERE thread_id=${request.threadId}::uuid AND client_request_id=${request.clientRequestId}`
        : [];

      return { state: owned[0]!, response: stored[0]?.response };
    }),
  );

  if (!response) return { state };

  return { state, replay: await replay(core, request, fromBinary(ui.SendMessageResponseSchema, response)) };
}

/** The receipt fixes admission, while delivery/execution can advance after the response was lost. */
async function replay(
  core: GatewayCore,
  request: ui.SendMessageRequest,
  result: ui.SendMessageResponse,
): Promise<MessageResponse> {
  if (result.steer) {
    const steer = await core[coreState].actions.run(
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
