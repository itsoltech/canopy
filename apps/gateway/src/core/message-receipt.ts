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

/** Everything a message's checks read that a writer changes under this thread's lock, read after the lock. */
export interface AdmissionState {
  worker_id: string | null;
  cwd: string | null;
  provider: string;
  provider_profile_id: string | null;
  model: string;
  archived: boolean;
  deleted: boolean;
  rewind_pending_id: string | null;
  /** Bumped by every pull request link, unlink and account change: what citations are checked against. */
  pull_request_revision: string;
  import_mode: string | null;
  importing: boolean;
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

      if (lock) {
        const owned = yield* sql`SELECT id FROM threads WHERE id=${request.threadId}::uuid
          AND owner_user_id=${options.userId}::uuid FOR UPDATE`;

        if (!owned.length) return yield* Effect.fail(new NotFound("thread not found"));
      }

      // Separate from the lock: this snapshot follows it, so it sees what committed while the lock waited
      // (a receipt, an unlinked pull request, an import), not only the thread row itself.
      const rows = yield* sql<AdmissionState & { response: Uint8Array | null }>`SELECT r.response,t.worker_id,t.cwd,
        t.provider,t.provider_profile_id,coalesce(t.settings->>'model','') AS model,t.archived_at IS NOT NULL AS archived,
        t.deleted_at IS NOT NULL AS deleted,t.rewind_pending_id,t.pull_request_revision::text AS pull_request_revision,
        (SELECT ti.mode FROM thread_imports ti WHERE ti.thread_id=t.id) AS import_mode,
        EXISTS(SELECT 1 FROM import_items i WHERE i.thread_id=t.id AND i.status IN ('pending','importing')) AS importing
        FROM threads t LEFT JOIN thread_message_receipts r ON r.thread_id=t.id AND r.client_request_id=${request.clientRequestId}
        WHERE t.id=${request.threadId}::uuid AND t.owner_user_id=${options.userId}::uuid`;

      if (!rows.length) return yield* Effect.fail(new NotFound("thread not found"));
      const { response, ...state } = rows[0]!;

      return { state, response: request.clientRequestId ? response : null };
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
