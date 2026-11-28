import { dropMoveFiles, keepMoveFiles, moveKey, reservation, serialized } from "./move-native-files.ts";
import { restoreArchived } from "./move-state.ts";
import { nativePlacement, serveMoveFiles } from "./move-native-target.ts";
import { create, toJson, type DescMethod, type Message } from "@bufbuild/protobuf";

import { timestampNow } from "@bufbuild/protobuf/wkt";

import { Code, ConnectError } from "@connectrpc/connect";

import { computerLink as link, NoticeLevel, ThreadEventSchema, ui } from "@canopy/contracts";

import { permissionModeOf } from "../store/index.ts";

import { providerOf } from "../store/instance-config.ts";

import { linkedMessage } from "./remote.ts";
import { uuid } from "./agents-context.ts";

import {
  applyBot,
  applyThreadRows,
  botRowsJson,
  decideTarget,
  finishThread,
  localHistory,
  MoveRefused,
  moveRow,
  payloadOf,
  stage,
  threadRowJson,
  type MoveRow,
} from "./move-state.ts";
import { handoffNote, movesState } from "./moves-context.ts";
import { movesCore, movesRun } from "./moves-recovery.ts";
import { movesChanged } from "./moves-source.ts";
import type { ComputerMoves } from "./moves.ts";
import { movedAttachment, movedVisual, validateMoveContent } from "./move-validation.ts";

export async function movesInspection(hostContext: ComputerMoves, request: link.MoveInspect) {
  const instances = await hostContext[movesState].store.query<{ key: string }>(
    `SELECT harness || ':' || id AS key FROM provider_instances WHERE harness || ':' || id = ANY($1::text[])
     AND (created_by IS NULL OR created_by=$2::uuid)`,
    [request.providerInstances.slice(0, 200), hostContext[movesState].store.owner],
  );

  const projects = await hostContext[movesState].store.query<{ id: string }>(
    `SELECT id::text FROM projects WHERE owner_user_id=$1::uuid AND id::text = ANY($2::text[]) AND archived_at IS NULL`,
    [hostContext[movesState].store.owner, request.projectIds.slice(0, 500)],
  );

  return create(link.MoveInspectionSchema, {
    providerInstances: instances.map((i) => i.key),
    projectIds: projects.map((p) => p.id),
  });
}

/** The source's decision for a move the target staged. Unknown here means it never committed. */
export async function movesOutcome(hostContext: ComputerMoves, peer: string, moveId: string) {
  const move = await moveRow(hostContext[movesState].store, moveId);

  if (!move || move.role !== "source" || move.peer_node_id !== peer)
    return create(link.MoveReplySchema, { state: "abort" });

  if (move.state === "preparing") return create(link.MoveReplySchema, { state: "preparing" });

  return create(link.MoveReplySchema, { state: ["committed", "done"].includes(move.state) ? "commit" : "abort" });
}

/** Validates and stages a move on this computer. Nothing here runs until the source decides. */
export async function movesPrepare(hostContext: ComputerMoves, peer: string, prepare: link.MovePrepare) {
  const reply = (error: string, state = "refused") => create(link.MoveReplySchema, { state, error });

  // A bot never carries a thread's session and files.
  if (
    !uuid(prepare.moveId) ||
    !uuid(prepare.itemId) ||
    !["thread", "bot"].includes(prepare.kind) ||
    (prepare.kind === "bot" && prepare.native)
  )
    return reply("Invalid move");
  prepare.moveId = prepare.moveId.toLowerCase();
  prepare.itemId = prepare.itemId.toLowerCase();
  const known = await moveRow(hostContext[movesState].store, prepare.moveId);

  if (known)
    return known.role === "target" &&
      known.peer_node_id === peer &&
      known.kind === prepare.kind &&
      known.item_id === prepare.itemId
      ? reply("", known.state === "aborted" ? "refused" : "prepared")
      : reply("Invalid move");

  // Files staged for this move id belong to the partner that sent them, also when this move has none; a move without
  // them first drops what was staged (it can't be left without an owner).
  const files = await reservation(hostContext, prepare.moveId);

  if (files && files.peer_node_id !== peer) return reply("Invalid move");

  if (files && files.state !== "done" && !prepare.native) {
    await dropMoveFiles(hostContext, prepare.moveId, peer).catch(() => {});

    if ((await reservation(hostContext, prepare.moveId))?.state !== "done")
      return reply("This computer is still removing the move's files. Try the move again in a moment.");
  }

  const placement: MoveRow["placement"] = {};
  const redo: string[] = [];

  try {
    validateMoveContent(prepare);
  } catch (error) {
    return reply(error instanceof MoveRefused ? error.message : "The move contains invalid records.");
  }

  if (prepare.kind === "thread") {
    const threads = prepare.thread?.threads ?? [];
    const rows = threads.map((t) => threadRowJson(t.rowJson));

    if (
      !rows.length ||
      rows[0]!.id !== prepare.itemId ||
      rows.some((r, i) => i > 0 && r.parent_thread_id !== prepare.itemId)
    )
      return reply("Invalid thread move");

    const workspace = (
      await hostContext[movesState].store
        .query<{ project_id: string; worker_id: string }>(
          `SELECT w.project_id, w.worker_id FROM project_workspaces w JOIN projects p ON p.id = w.project_id
        WHERE w.id=$1::uuid AND p.owner_user_id=$2::uuid AND w.archived_at IS NULL AND p.archived_at IS NULL`,
          [prepare.workspaceId, hostContext[movesState].store.owner],
        )
        .catch(() => [])
    )[0];

    if (!workspace) return reply("The chosen workspace is not on this computer.");
    Object.assign(placement, { workspaceId: prepare.workspaceId, projectId: workspace.project_id });

    if (prepare.native && !(await nativePlacement(hostContext, peer, prepare, rows)))
      return reply("The moved files are not on this computer. Try the move again.");

    const instances = [
      ...new Set(rows.filter((r) => r.provider_profile_id).map((r) => `${r.provider}:${r.provider_profile_id}`)),
    ];

    const have = (await movesInspection(hostContext, create(link.MoveInspectSchema, { providerInstances: instances })))
      .providerInstances;

    const missing = instances.filter((i) => !have.includes(i));

    if (missing.length)
      return reply(
        `Provider instance ${missing.map((i) => i.split(":")[1]).join(", ")} is not on this computer. Share it first.`,
      );
    redo.push(
      prepare.native
        ? "The agent continues its session here in a new worktree"
        : "The agent continues in a new session here with a handoff note",
    );
  } else {
    const rows = botRowsJson(prepare.bot?.rowsJson || "{}");

    if (rows.bot?.id !== prepare.itemId) return reply("Invalid bot move");

    if (
      rows.bot.provider_instance !== "native" &&
      !(
        await movesInspection(
          hostContext,
          create(link.MoveInspectSchema, {
            providerInstances: [`${rows.bot.provider}:${rows.bot.provider_instance}`],
          }),
        )
      ).providerInstances.length
    )
      return reply(`Provider instance ${rows.bot.provider_instance} is not on this computer. Share it first.`);
    redo.push(
      ...rows.grants.map((g) => `Connect ${g.name} (${g.connector_type}) again`),
      ...rows.mcp.map((m) => `Add the MCP server ${m.name} again`),
    );
  }

  const state = await stage(hostContext[movesState].store, peer, prepare, placement, redo);

  if (state === "exists") return reply("It is already on this computer (moving a thing back is not supported yet).");

  if (state !== "prepared") return reply("Invalid move");
  await hostContext[movesState].host.hook?.("staged", { id: prepare.moveId, role: "target" });

  return reply("", "prepared");
}

// ------------------------------------------------------------------ target: apply

export async function movesApply(hostContext: ComputerMoves, moveId: string) {
  if (hostContext[movesState].driving.has(moveId) || hostContext[movesState].closed) return;
  hostContext[movesState].driving.add(moveId);

  try {
    const move = await moveRow(hostContext[movesState].store, moveId);

    if (move?.role !== "target" || move.state !== "committed") return;
    const self = hostContext[movesState].host.self();
    let ids = [move.item_id];

    try {
      const prepare = await payloadOf(hostContext[movesState].store, move);

      if (prepare.kind !== move.kind || prepare.itemId !== move.item_id || prepare.moveId !== move.id)
        throw new MoveRefused("The staged item does not match the move decision.");
      validateMoveContent(prepare);

      if (move.kind === "bot") await applyBot(hostContext[movesState].store, move, self, prepare.bot!);
      else ids = await movesApplyThread(hostContext, move, self, prepare.thread!, prepare.native);
    } catch (error) {
      // The decision is final: the staged state stays and the tick tries again.
      await hostContext[movesState].store.query(
        `UPDATE computer_moves SET error=$3, updated_at=now() WHERE owner_user_id=$1::uuid AND id=$2::uuid`,
        [
          hostContext[movesState].store.owner,
          moveId,
          `Arriving: ${error instanceof Error ? error.message : "retrying"}`.slice(0, 500),
        ],
      );

      return;
    }

    await hostContext[movesState].host.redirects.committed(move.kind, ids, move.peer_node_id);
    await movesChanged(hostContext, move.kind, move.item_id, ids);
  } finally {
    hostContext[movesState].driving.delete(moveId);
  }
}

export async function movesApplyThread(
  hostContext: ComputerMoves,
  move: MoveRow,
  self: { nodeId: string; name: string },
  prepare: link.ThreadMove,
  native?: link.MoveNative,
) {
  const threads = prepare.threads;
  const rows = threads.map((t) => threadRowJson(t.rowJson));
  const ids = rows.map((row) => row.id);
  // Older sources omitted bot watches and fork origins. Isolate the imported family before any turn can run.
  const legacyAudience = rows.some((row) => row.memory_audience === undefined) ? `legacy:move:${move.id}` : undefined;

  const family = new Set(ids);
  const files = new Set(prepare.files.map((f) => movedAttachment(f).id));

  const workspace = (
    await hostContext[movesState].store.query<{ project_id: string; root_path: string }>(
      `SELECT project_id, root_path FROM project_workspaces WHERE id=$1::uuid`,
      [move.placement.workspaceId],
    )
  )[0];

  if (!workspace) throw new Error("the chosen workspace was removed");
  const from = prepare.sourceName || "the other computer";

  for (const thread of threads) {
    const row = threadRowJson(thread.rowJson);
    const visuals = new Set(thread.visualsJson.map((json) => movedVisual(json).visual_id));
    const history = localHistory(thread.history!, move.peer_node_id, { threads: family, files, visuals });

    const request = create(ui.CreateThreadRequestSchema, {
      projectId: workspace.project_id,
      workspaceId: move.placement.workspaceId!,
      title: row.title,
      provider: providerOf(row.provider),
      providerProfileId: row.provider_profile_id ?? "",
      model: row.settings.model ?? "",
      effort: row.settings.effort ?? "",
      serviceTier: row.settings.serviceTier ?? "",
      permissionMode: permissionModeOf(row.settings.permissionMode || "ASK"),
      instructions: row.settings.instructions ?? "",
      parentThreadId: row.kind === "side" ? (row.parent_thread_id ?? "") : "",
      clientRequestId: `move:${move.id}:${row.id}`,
      // Native continuation: the session and files already wait in this worktree (docs/thread-transfers.md).
      ...(native &&
        row.kind === "main" && { workspaceMode: ui.WorkspaceMode.EXISTING_WORKTREE, worktreeId: native.worktreeId }),
    });

    const session = native?.sessions[row.id];

    const notice = create(ThreadEventSchema, {
      eventId: crypto.randomUUID(),
      threadId: row.id,
      occurredAt: timestampNow(),
      body: {
        case: "notice",
        value: {
          level: NoticeLevel.INFO,
          code: "moved",
          message: `Moved from ${from} to ${self.name}`,
          dataJson: JSON.stringify({ from_node_id: move.peer_node_id }),
        },
      },
    });

    await movesCore(hostContext).createMovedThread(
      request,
      row.id,
      () =>
        applyThreadRows(hostContext[movesState].store, move, thread, {
          threadId: row.id,
          projectId: workspace.project_id,
          ordinalTurn: crypto.randomUUID(),
          history,
          handoff: handoffNote(history, {
            from,
            to: self.name,
            oldCwd: row.cwd ?? "",
            newCwd: workspace.root_path,
            title: row.title,
          }),
          notice: { eventId: notice.eventId, payload: toJson(ThreadEventSchema, notice) },
          files: prepare.files,
          blobs: prepare.blobs,
          ...(session &&
            native && {
              native: {
                sessionId: session,
                note: `[canopy] This thread moved from ${from} (${row.cwd ?? ""}) to ${self.name} (${native.cwd}). Paths in earlier messages refer to the old folder; use the new one.`,
              },
            }),
        }),
      row.kind === "main" ? legacyAudience : undefined,
      Boolean(session),
    );
  }

  // Archived once the whole family exists (a side thread can't be created under an archived main thread), each at
  // its own original time. A failure keeps the move committed, so recovery applies it again.
  // The reason travels in the history snapshot: a side thread closed with its main thread reopens with it.
  await restoreArchived(
    hostContext[movesState].store,
    rows.map((row, i) => ({
      ...row,
      archived_by: threads[i]!.history?.thread?.archivedBy,
      archived_by_thread_id: threads[i]!.history?.thread?.archivedByThreadId,
    })),
  );

  await finishThread(hostContext[movesState].store, move, ids, self);

  return ids;
}

export interface MovesTargetMethods {
  serve(peer: string, method: DescMethod, request: Message): Promise<Message>;
}

export const movesTargetMethods: MovesTargetMethods = {
  // ------------------------------------------------------------------ link: served on the other side

  async serve(this: ComputerMoves, peer: string, method: DescMethod, request: Message): Promise<Message> {
    // Everything of one move runs in order with its files' steps (move-native-files.ts).
    if (method.name === "PrepareMove") {
      const prepare = linkedMessage(link.MovePrepareSchema, request);

      return serialized(this, moveKey(prepare.moveId), () => movesPrepare(this, peer, prepare));
    }

    if (method.name === "DecideMove") {
      const decision = linkedMessage(link.MoveDecisionSchema, request);

      if (!["commit", "abort"].includes(decision.decision))
        throw new ConnectError("Unknown decision", Code.InvalidArgument);

      const state = await serialized(this, moveKey(decision.moveId), async () => {
        const decided = await decideTarget(this[movesState].store, peer, decision.moveId, decision.decision);

        // Durable first, and only this partner's move: its files go with an abort.
        if (decided === "aborted") await dropMoveFiles(this, decision.moveId, peer).catch(() => {});

        return decided;
      });

      await this[movesState].host.hook?.("decided", { id: decision.moveId, role: "target" });

      if (state === "committed")
        void movesRun(
          this,
          movesApply(this, decision.moveId)
            .then(() => serialized(this, moveKey(decision.moveId), () => keepMoveFiles(this, decision.moveId)))
            .catch(() => {}),
        );

      return create(link.MoveReplySchema, { state });
    }

    if (method.name === "MoveOutcome")
      return movesOutcome(this, peer, linkedMessage(link.MoveDecisionSchema, request).moveId);

    if (method.name === "InspectMove") return movesInspection(this, linkedMessage(link.MoveInspectSchema, request));

    if (method.name === "TransferMoveFiles")
      return serveMoveFiles(this, peer, linkedMessage(link.MoveFilesSchema, request));
    throw new ConnectError("Unknown move method", Code.Unimplemented);
  },
};
