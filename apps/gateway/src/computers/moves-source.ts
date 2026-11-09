import { create } from "@bufbuild/protobuf";

import { Code, ConnectError } from "@connectrpc/connect";

import { computerLink as link, ui } from "@canopy/contracts";

import { nodeRef, qualifyId, splitId, REMOTE_BOT_COMPOSER } from "@canopy/domain/computers";

import {
  commitSource,
  exportBot,
  exportThread,
  freezeBot,
  freezeThread,
  MoveRefused,
  moveRow,
  redirectItem,
  unfreezeSource,
  type MoveRow,
} from "./move-state.ts";
import { DECIDE_TIMEOUT_MS, MoveCrash, movesState, ms, PREPARE_TIMEOUT_MS } from "./moves-context.ts";
import { movesEverything } from "./moves-preview.ts";
import { movesCore, movesHook, movesRows, movesRun, movesUnary } from "./moves-recovery.ts";
import type { ComputerMoves } from "./moves.ts";

export async function movesRefused(
  hostContext: ComputerMoves,
  moveId: string,
  ref: { kind: string; id: string },
  target: string,
  error: string,
  batchId?: string,
) {
  const title =
    ref.kind === "bot"
      ? (
          await hostContext[movesState].store.query<{ t: string }>(
            `SELECT configuration ->> 'name' AS t FROM bots WHERE id=$1::uuid AND owner_user_id=$2::uuid`,
            [ref.id, hostContext[movesState].store.owner],
          )
        )[0]?.t
      : (
          await hostContext[movesState].store.query<{ t: string }>(
            `SELECT title AS t FROM threads WHERE id=$1::uuid AND owner_user_id=$2::uuid`,
            [ref.id, hostContext[movesState].store.owner],
          )
        )[0]?.t;

  await hostContext[movesState].store.query(
    `INSERT INTO computer_moves(owner_user_id,id,role,peer_node_id,kind,item_id,batch_id,title,state,error) VALUES ($1::uuid,$2::uuid,'source',$3,$4,$5::uuid,$6::uuid,$7,'aborted',$8)`,
    [hostContext[movesState].store.owner, moveId, target, ref.kind, ref.id, batchId ?? null, title ?? "", error],
  );
}

/** Thread and bot lists change when a thing freezes, leaves or arrives. */
export async function movesChanged(hostContext: ComputerMoves, kind: string, id: string, family: string[] = [id]) {
  if (kind === "thread") await movesCore(hostContext).threadsChanged(family);
  else
    await hostContext[movesState].store
      .query("UPDATE bots SET revision=revision+1 WHERE id=$1::uuid", [id])
      .catch(() => {});
}

// ------------------------------------------------------------------ source: drive one move

export async function movesDrive(hostContext: ComputerMoves, moveId: string) {
  if (hostContext[movesState].driving.has(moveId) || hostContext[movesState].closed) return;
  hostContext[movesState].driving.add(moveId);

  try {
    const move = await moveRow(hostContext[movesState].store, moveId);

    if (move?.state !== "preparing") return;
    const target = move.peer_node_id;

    try {
      await movesHook(hostContext, "frozen", move);

      const prepare = create(link.MovePrepareSchema, {
        moveId,
        kind: move.kind,
        itemId: move.item_id,
        batchId: move.batch_id ?? "",
        title: move.title,
        workspaceId: move.placement.workspaceId ?? "",
      });

      const name = hostContext[movesState].host.self().name;

      if (move.kind === "thread")
        prepare.thread = await exportThread(
          hostContext[movesState].store,
          (id) => movesHistory(hostContext, id),
          move.frozen.family ?? [move.item_id],
          move.frozen,
          name,
        );
      else prepare.bot = await exportBot(hostContext[movesState].store, move.item_id, name);

      if (
        (prepare.bot?.draft || prepare.bot?.files.length) &&
        !(await hostContext[movesState].store.peer(target))?.capabilities.includes(REMOTE_BOT_COMPOSER)
      )
        throw new MoveRefused("Update the other computer to move this bot's draft and images.");

      if (!hostContext[movesState].host.ready(target))
        throw new MoveRefused(
          (await hostContext[movesState].host.unavailable(target)) || "The other computer is not connected.",
        );

      const reply = await movesUnary<link.MoveReply>(
        hostContext,
        target,
        link.ComputerMoveService.method.prepareMove,
        prepare,
        PREPARE_TIMEOUT_MS,
      );

      if (reply.state !== "prepared") throw new MoveRefused(reply.error || "The other computer refused the move.");
      await movesHook(hostContext, "prepared", move);
    } catch (error) {
      if (error instanceof MoveCrash) return;

      // Before the decision: roll back here; the target drops what it staged.
      const reason =
        error instanceof MoveRefused
          ? error.message
          : error instanceof ConnectError
            ? error.rawMessage
            : "The move failed. Nothing changed.";

      if ((await unfreezeSource(hostContext[movesState].store, moveId, reason)) === "aborting")
        await movesChanged(hostContext, move.kind, move.item_id, move.frozen.family);
      await movesSettle(hostContext, moveId).catch(() => {});

      return;
    }

    const home = { nodeId: target, name: await hostContext[movesState].host.name(target) };

    if (
      (await commitSource(hostContext[movesState].store, move, home, hostContext[movesState].host.self().nodeId)) !==
      "committed"
    )
      return;
    const family = move.kind === "thread" ? (move.frozen.family ?? [move.item_id]) : [move.item_id];
    hostContext[movesState].host.broadcast(
      family.map((id) => redirectItem(id, move.kind, home, hostContext[movesState].host.self().nodeId)),
    );

    for (const id of family)
      await hostContext[movesState].host.redirects.record(
        redirectItem(id, move.kind, home, hostContext[movesState].host.self().nodeId),
      );
    await movesChanged(hostContext, move.kind, move.item_id, family);

    try {
      await movesHook(hostContext, "committed", move);
    } catch {
      return;
    }

    await movesSettle(hostContext, moveId).catch(() => {});
  } finally {
    hostContext[movesState].driving.delete(moveId);
  }
}

/** The thread as its home shows it (the core's snapshot, moved history included). */
export async function movesHistory(hostContext: ComputerMoves, threadId: string): Promise<ui.ThreadSnapshot> {
  const abort = new AbortController();

  try {
    for await (const update of movesCore(hostContext).watchThread(threadId, abort.signal))
      if (update.change.case === "snapshot") return update.change.value;
  } finally {
    abort.abort();
  }

  throw new Error("missing thread snapshot");
}

/** Tells the target a decision it has not confirmed yet. Retried by the tick until it does. */
export async function movesSettle(hostContext: ComputerMoves, moveId: string) {
  const move = await moveRow(hostContext[movesState].store, moveId);

  if (
    !move ||
    move.role !== "source" ||
    !["committed", "aborting"].includes(move.state) ||
    !hostContext[movesState].host.ready(move.peer_node_id)
  )
    return;
  const decision = move.state === "committed" ? "commit" : "abort";

  const reply = await movesUnary<link.MoveReply>(
    hostContext,
    move.peer_node_id,
    link.ComputerMoveService.method.decideMove,
    create(link.MoveDecisionSchema, { moveId, decision }),
    DECIDE_TIMEOUT_MS,
  );

  const confirmed =
    decision === "commit" ? ["committed", "done"].includes(reply.state) : ["aborted", "missing"].includes(reply.state);

  if (confirmed)
    await hostContext[movesState].store.query(
      `UPDATE computer_moves SET state=$3, updated_at=now() WHERE owner_user_id=$1::uuid AND id=$2::uuid AND state=$4`,
      [hostContext[movesState].store.owner, moveId, decision === "commit" ? "done" : "aborted", move.state],
    );
}

export interface MovesSourceMethods {
  start(request: ui.StartMoveRequest): Promise<ui.MovesSnapshot>;
  list(batchId?: string, ids?: string[]): Promise<ui.MovesSnapshot>;
}

export const movesSourceMethods: MovesSourceMethods = {
  async start(this: ComputerMoves, request: ui.StartMoveRequest): Promise<ui.MovesSnapshot> {
    const target = request.nodeId;
    const unavailable = await this[movesState].host.unavailable(target);

    if (unavailable) throw new ConnectError(unavailable, Code.FailedPrecondition);

    if (request.items.some((i) => splitId(i.id).node))
      throw new ConnectError("Open it on its own computer to move it", Code.InvalidArgument);

    const refs = request.everything
      ? await movesEverything(this)
      : request.items.map((i) => ({ kind: i.kind, id: i.id }));

    if (!refs.length) throw new ConnectError("Nothing to move", Code.InvalidArgument);

    if (refs.some((r) => !["thread", "bot"].includes(r.kind)))
      throw new ConnectError("Only threads and bots can move", Code.InvalidArgument);
    const placements = new Map<string, string>();

    for (const p of request.placements) {
      const { id, node } = splitId(p.workspaceId);

      if (node !== nodeRef(target))
        throw new ConnectError("Choose a workspace on the computer the threads move to", Code.InvalidArgument);
      placements.set(splitId(p.projectId).id, id);
    }

    const batchId = refs.length > 1 ? crypto.randomUUID() : undefined;
    const started: string[] = [];
    const all: string[] = [];

    for (const ref of refs) {
      const moveId = crypto.randomUUID();
      all.push(moveId);
      let result: { error: string };

      if (ref.kind === "thread") {
        const project =
          (
            await this[movesState].store.query<{ project_id: string }>(
              `SELECT project_id FROM threads WHERE id=$1::uuid AND owner_user_id=$2::uuid`,
              [ref.id, this[movesState].store.owner],
            )
          )[0]?.project_id ?? "";

        const workspaceId = placements.get(project);
        result = workspaceId
          ? await freezeThread(this[movesState].store, {
              moveId,
              threadId: ref.id,
              target,
              ...(batchId && { batchId }),
              placement: { workspaceId },
            })
          : { error: "Choose a workspace on the other computer for its project." };
      } else
        result = await freezeBot(this[movesState].store, {
          moveId,
          botId: ref.id,
          target,
          ...(batchId && { batchId }),
        });

      if (result.error) await movesRefused(this, moveId, ref, target, result.error, batchId);
      else {
        started.push(moveId);
        await movesChanged(this, ref.kind, ref.id);
      }
    }

    // One move at a time: a laptop's worth of threads should not compete for the link.
    void movesRun(
      this,
      (async () => {
        for (const id of started) await movesDrive(this, id);
      })(),
    );

    return this.list(batchId ?? "", all);
  },

  async list(this: ComputerMoves, batchId = "", ids: string[] = []): Promise<ui.MovesSnapshot> {
    const rows = batchId
      ? await movesRows(this, "batch_id=$2::uuid", [batchId])
      : ids.length
        ? await movesRows(this, "id=ANY($2::uuid[])", [ids])
        : await this[movesState].store.query<MoveRow>(
            `SELECT * FROM computer_moves WHERE owner_user_id=$1::uuid ORDER BY updated_at DESC LIMIT 100`,
            [this[movesState].store.owner],
          );

    return create(ui.MovesSnapshotSchema, {
      moves: await Promise.all(
        rows.map(async (m) =>
          create(ui.ComputerMoveSchema, {
            id: m.id,
            batchId: m.batch_id ?? "",
            kind: m.kind,
            itemId: m.item_id,
            title: m.title,
            role: m.role,
            nodeId: m.peer_node_id,
            nodeName: await this[movesState].host.name(m.peer_node_id),
            state: m.state,
            error: m.error,
            redo: m.redo,
            updatedAtMs: ms(m.updated_at),
            newId:
              m.role === "source" && ["committed", "done"].includes(m.state)
                ? qualifyId(m.item_id, m.peer_node_id)
                : m.role === "target" && m.state === "done"
                  ? m.item_id
                  : "",
          }),
        ),
      ),
    });
  },
};
