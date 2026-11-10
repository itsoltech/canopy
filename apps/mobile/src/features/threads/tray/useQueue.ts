import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { ConnectError } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { moveTo, ordered } from "@canopy/domain/queue";
import { orderThreadTurns } from "@canopy/domain/history-pages";
import { useSession } from "../../../state/session";
import { toast } from "../../../ui/Toast";

const failure = (cause: unknown) => ConnectError.from(cause).rawMessage;

/** The thread's live parts the queue is built from, and where the gateway's answers go before the stream has them. */
export interface QueueSource {
  readonly threadId: string;
  readonly turns: readonly ui.Turn[];
  readonly steers: readonly ui.Steer[];
  readonly running: boolean;
  readonly apply: (update: ui.ThreadUpdate) => void;
}

/**
 * The tray's queue (web: QueueState): the user's queued messages as shown, with what the user just did applied at
 * once (a new order, a deleted or steered message gone). The gateway confirms each change; a refusal (the message
 * already started) puts back what it has and a toast says why. Deleting offers Undo.
 */
export function useQueue({ threadId, turns, steers, running, apply }: QueueSource) {
  const { client } = useSession();
  const [order, setOrder] = useState<string[]>();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const own = orderThreadTurns(turns.filter((t) => !t.inherited && !t.withdrawn && !hidden.has(t.id)));
  const rows = ordered(own, order);

  const upsert = (turn: ui.Turn | undefined) => {
    if (turn) apply(create(ui.ThreadUpdateSchema, { change: { case: "turn", value: turn } }));
  };

  /** Moves a row and sends the new order; the gateway's answer (new ordinals) replaces it. */
  async function move(id: string, index: number) {
    const ids = moveTo(
      rows.map((t) => t.id),
      id,
      index,
    );

    if (!client || ids.every((x, i) => x === rows[i]?.id)) return;
    setOrder(ids);

    try {
      const { turns: moved } = await client.api.reorderQueuedTurns({ threadId, turnIds: ids });
      moved.forEach(upsert);
    } catch (cause) {
      toast(`Could not reorder: ${failure(cause)}`);
    } finally {
      setOrder((current) => (current === ids ? undefined : current));
    }
  }

  async function withdraw(turn: ui.Turn, what: string, run: () => Promise<void>) {
    setHidden((current) => new Set(current).add(turn.id));

    try {
      await run();
    } catch (cause) {
      toast(`${what}: ${failure(cause)}`);
    } finally {
      setHidden((current) => {
        const next = new Set(current);
        next.delete(turn.id);

        return next;
      });
    }
  }

  /** Out of the queue at once; the toast offers Undo (back at its place). */
  const remove = (turn: ui.Turn) =>
    withdraw(turn, "Could not delete", async () => {
      if (!client) return;
      upsert((await client.api.deleteQueuedTurn({ turnId: turn.id })).turn);
      toast("Message deleted", {
        label: "Undo",
        run: async () => {
          try {
            upsert((await client.api.restoreQueuedTurn({ turnId: turn.id })).turn);
          } catch (cause) {
            toast(`Could not restore: ${failure(cause)}`);
          }
        },
      });
    });

  /** Into the running turn now; it leaves the queue (and comes back to its place if it cannot join). */
  const steer = (turn: ui.Turn) =>
    withdraw(turn, "Could not steer", async () => {
      if (!client) return;
      const result = await client.api.steerQueuedTurn({ turnId: turn.id });
      upsert(result.turn);

      if (result.steer) apply(create(ui.ThreadUpdateSchema, { change: { case: "steer", value: result.steer } }));
    });

  return {
    rows,
    running,
    move,
    remove,
    steer,
    /** The steer that could not join the running turn and is this queued turn again (runs at its place). */
    fallback: (turnId: string) => steers.findLast((s) => s.queuedTurnId === turnId && s.status === "queued"),
  };
}

export type Queue = ReturnType<typeof useQueue>;
