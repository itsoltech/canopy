import { createHash } from "node:crypto";
import { toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { toConnectError } from "../api/ui-errors.ts";
import type { ThreadRow } from "../store/index.ts";
import { coreBroadcastThread, coreRun } from "./core-broadcast.ts";
import { coreState, InvalidError } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";

interface Flight {
  fingerprint: string;
  result: Promise<ui.Thread>;
}

const flights = new WeakMap<GatewayCore, Map<string, Flight>>();

export async function singleCreation(
  core: GatewayCore,
  input: ui.CreateThreadRequest,
  start: (fingerprint: string) => Promise<ui.Thread>,
  join: () => void,
) {
  const id = input.clientRequestId;
  const fingerprint = createHash("sha256").update(toBinary(ui.CreateThreadRequestSchema, input)).digest("hex");
  const active = flights.get(core) ?? new Map<string, Flight>();
  const previous = active.get(id);

  if (previous) {
    if (previous.fingerprint !== fingerprint)
      throw new InvalidError("This request already contains a different message.");

    join();

    return previous.result;
  }

  const result = start(fingerprint);
  active.set(id, { fingerprint, result });
  flights.set(core, active);

  try {
    return await result;
  } finally {
    active.delete(id);
  }
}

export async function reserveWorktreeThread(core: GatewayCore, request: ui.CreateThreadRequest, fingerprint: string) {
  const row = await coreRun(core, (s) =>
    s.createThread(core[coreState].options.userId, request, undefined, undefined, undefined, fingerprint),
  );

  if (row.preparation_fingerprint !== fingerprint)
    throw new InvalidError("This request already belongs to another thread.");

  await coreBroadcastThread(core, row.id);

  return row;
}

/** Called inside the transaction that also records the first message and the worker outbox command. */
export async function finishWorktreePlacement(core: GatewayCore, pending: ThreadRow, request: ui.CreateThreadRequest) {
  const { actions } = core[coreState];

  const updated = await actions.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const workspace = yield* sql`SELECT pw.id FROM project_workspaces pw
        JOIN projects p ON p.id=pw.project_id JOIN workers w ON w.id=pw.worker_id
        WHERE pw.id=${pending.workspace_id}::uuid AND p.id=${pending.project_id}::uuid
          AND p.owner_user_id=${pending.owner_user_id}::uuid AND p.archived_at IS NULL AND pw.archived_at IS NULL
          AND (w.owner_user_id IS NULL OR w.owner_user_id=${pending.owner_user_id}::uuid)
          AND w.archived_at IS NULL AND w.revoked_at IS NULL FOR SHARE OF p`;

      if (!workspace.length) return [];

      return yield* sql`UPDATE threads SET cwd=${request.cwd}, worktree_id=${request.worktreeId}::uuid,
          preparation_fingerprint=NULL, status_detail=NULL
        WHERE id=${pending.id}::uuid AND owner_user_id=${pending.owner_user_id}::uuid
          AND preparation_fingerprint=${pending.preparation_fingerprint} AND status='creating'
          AND archived_at IS NULL AND deleted_at IS NULL RETURNING id`;
    }),
  );

  if (!updated.length) throw new InvalidError("The thread or its workspace is no longer available.");

  return coreRun(core, (s) => s.thread(pending.id));
}

export async function failWorktreePreparation(core: GatewayCore, pending: ThreadRow, cause: unknown) {
  const detail = toConnectError(cause).rawMessage;

  const changed = await core[coreState].actions.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql`UPDATE threads SET status=CASE WHEN archived_at IS NULL THEN 'failed' ELSE 'archived' END,
        status_detail=${detail} WHERE id=${pending.id}::uuid AND owner_user_id=${pending.owner_user_id}::uuid
        AND preparation_fingerprint=${pending.preparation_fingerprint} RETURNING id`;
    }),
  );

  if (changed.length) await coreBroadcastThread(core, pending.id);
}

/** A gateway restart lost the Git query. Keep its thread visible and leave the unsent draft intact. */
export async function settleInterruptedWorktreePreparations(core: GatewayCore) {
  const { actions, options } = core[coreState];
  await actions.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE threads SET status=CASE WHEN archived_at IS NULL THEN 'failed' ELSE 'archived' END,
        status_detail='Canopy restarted during thread preparation. Return to your draft to try again.'
        WHERE owner_user_id=${options.userId}::uuid AND preparation_fingerprint IS NOT NULL AND status_detail IS NULL`;
    }),
  );
}
