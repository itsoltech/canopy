import { create, type DescMethod, type Message } from "@bufbuild/protobuf";

import { Code, ConnectError } from "@connectrpc/connect";

import { computerLink as link } from "@canopy/contracts";

import { decideTarget, discardTarget, restoreSource, unfreezeSource, type MoveRow } from "./move-state.ts";
import { ACTIVE, ASK_AFTER_MS, DECIDE_TIMEOUT_MS, movesState, type MovePhase } from "./moves-context.ts";
import { movesChanged, movesDrive, movesSettle } from "./moves-source.ts";
import { movesApply } from "./moves-target.ts";
import type { ComputerMoves } from "./moves.ts";

export function movesCore(hostContext: ComputerMoves) {
  return hostContext[movesState].host.core;
}

export async function movesRows(hostContext: ComputerMoves, where: string, params: unknown[] = []) {
  return hostContext[movesState].store.query<MoveRow>(
    `SELECT * FROM computer_moves WHERE owner_user_id=$1::uuid AND ${where} ORDER BY created_at, id`,
    [hostContext[movesState].store.owner, ...params],
  );
}

export function movesRun<A>(hostContext: ComputerMoves, task: Promise<A>) {
  hostContext[movesState].tasks.add(task);
  void task.then(
    () => hostContext[movesState].tasks.delete(task),
    () => hostContext[movesState].tasks.delete(task),
  );

  return task;
}

export async function movesHook(hostContext: ComputerMoves, phase: MovePhase, move: { id: string; role: string }) {
  await hostContext[movesState].host.hook?.(phase, move);
}

export async function movesUnary<O extends Message>(
  hostContext: ComputerMoves,
  nodeId: string,
  method: DescMethod,
  request: Message,
  timeoutMs: number,
): Promise<O> {
  for await (const reply of hostContext[movesState].host.call(
    nodeId,
    method,
    request,
    AbortSignal.timeout(timeoutMs),
  )) {
    // SAFETY: Call sites select O from the method.output descriptor used by host.call to decode replies.
    return reply as O;
  }

  throw new ConnectError("The other computer sent no answer", Code.Internal);
}

export interface MovesRecoveryMethods {
  load(): Promise<void>;
  close(): Promise<PromiseSettledResult<unknown>[]>;
  tick(): Promise<void>;
  unlinked(nodeId: string): Promise<void>;
  frozen(ids: readonly string[]): Promise<string | undefined>;
}

export const movesRecoveryMethods: MovesRecoveryMethods = {
  /** After a restart nothing is half frozen: a move this computer had not decided yet rolls back. */
  async load(this: ComputerMoves) {
    for (const move of await movesRows(this, "role='source' AND state='preparing'"))
      await unfreezeSource(this[movesState].store, move.id, "This computer restarted before the move finished.");
  },

  close(this: ComputerMoves) {
    this[movesState].closed = true;

    return Promise.allSettled(this[movesState].tasks);
  },

  // ------------------------------------------------------------------ recovery

  /** Settles unfinished moves with every partner that is connected now. Called by the heartbeat. */
  async tick(this: ComputerMoves) {
    if (this[movesState].ticking || this[movesState].closed) return;
    this[movesState].ticking = true;

    try {
      for (const move of await movesRows(this, `state = ANY($2::text[])`, [ACTIVE])) {
        if (this[movesState].closed) break;

        if (move.role === "target" && move.state === "committed") {
          await movesApply(this, move.id);
          continue;
        }

        if (!this[movesState].host.ready(move.peer_node_id) || this[movesState].driving.has(move.id)) continue;

        try {
          if (move.role === "source" && move.state === "preparing") await movesDrive(this, move.id);
          else if (move.role === "source") await movesSettle(this, move.id);
          else if (move.state === "prepared" && Date.now() - new Date(move.updated_at).getTime() > ASK_AFTER_MS) {
            const outcome = await movesUnary<link.MoveReply>(
              this,
              move.peer_node_id,
              link.ComputerMoveService.method.moveOutcome,
              create(link.MoveDecisionSchema, { moveId: move.id }),
              DECIDE_TIMEOUT_MS,
            );

            if (outcome.state === "commit" || outcome.state === "abort") {
              if (
                (await decideTarget(this[movesState].store, move.peer_node_id, move.id, outcome.state)) === "committed"
              )
                await movesApply(this, move.id);
            }
          }
        } catch {
          /* the link dropped again; the next heartbeat retries */
        }
      }
    } finally {
      this[movesState].ticking = false;
    }
  },

  /**
   * Unlinking resolves every unfinished move with that computer: an undecided one rolls back, a decided one the
   * target never confirmed stays here (the source keeps its copy), and a target applies what it was told.
   */
  async unlinked(this: ComputerMoves, nodeId: string) {
    for (const move of await movesRows(this, `peer_node_id=$2 AND state = ANY($3::text[])`, [nodeId, ACTIVE])) {
      if (move.role === "source" && move.state === "preparing") {
        await unfreezeSource(this[movesState].store, move.id, "The other computer was unlinked.", "aborted");
        await movesChanged(this, move.kind, move.item_id, move.frozen.family);
      } else if (move.role === "source" && move.state === "aborting")
        await this[movesState].store.query(
          `UPDATE computer_moves SET state='aborted', updated_at=now() WHERE owner_user_id=$1::uuid AND id=$2::uuid`,
          [this[movesState].store.owner, move.id],
        );
      else if (move.role === "source") {
        await restoreSource(this[movesState].store, move);
        await this[movesState].host.redirects.load();
        await movesChanged(this, move.kind, move.item_id, move.frozen.family);
      } else if (move.state === "prepared") await discardTarget(this[movesState].store, move);
      else await movesApply(this, move.id);
    }
  },

  /** Why a write on this computer's thread or bot must wait: it is frozen for a move. */
  async frozen(this: ComputerMoves, ids: readonly string[]): Promise<string | undefined> {
    if (!ids.length) return undefined;

    const rows = await this[movesState].store.query<{ moved_to: string }>(
      `SELECT moved_to FROM threads WHERE id = ANY($1::uuid[]) AND moved_to IS NOT NULL AND deleted_at IS NULL
      UNION ALL SELECT moved_to FROM bots WHERE id = ANY($1::uuid[]) AND moved_to IS NOT NULL AND deleted_at IS NULL LIMIT 1`,
      [ids],
    );

    return rows[0]
      ? `Moving to ${await this[movesState].host.name(rows[0].moved_to)}. Try again in a moment.`
      : undefined;
  },
};
