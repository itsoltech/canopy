import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { attachmentsNote, withAttachmentsNote } from "@canopy/domain";
import { QueueStore, toUiSteer, toUiTurn, type TurnRow } from "../store/index.ts";
import { coreState, InvalidError, type TurnInputJson } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { coreComposeInput, coreMessageMentions } from "./core-mentions.ts";
import { coreSendSteer, coreSteers } from "./core-messages.ts";
import { coreRun } from "./core-broadcast.ts";

export async function corePublishQueued(hostContext: GatewayCore, row: TurnRow): Promise<ui.Turn> {
  const turn = toUiTurn(row);
  hostContext.hub.publishThread(
    row.thread_id,
    create(ui.ThreadUpdateSchema, { change: { case: "turn", value: turn } }),
  );

  return turn;
}

export function coreQueue<A, E>(
  hostContext: GatewayCore,
  use: (store: QueueStore["Service"]) => Effect.Effect<A, E>,
): Promise<A> {
  return hostContext[coreState].actions.run(QueueStore.use(use));
}

export interface CoreQueueMethods {
  reorderQueuedTurns(request: ui.ReorderQueuedTurnsRequest): Promise<ui.Turn[]>;
  editQueuedTurn(request: ui.EditQueuedTurnRequest): Promise<ui.Turn>;
  deleteQueuedTurn(turnId: string): Promise<ui.Turn>;
  restoreQueuedTurn(turnId: string): Promise<ui.Turn>;
  steerQueuedTurn(turnId: string): Promise<{ steer: ui.Steer; turn: ui.Turn }>;
}

export const coreQueueMethods: CoreQueueMethods = {
  // ------------------------------------------------------------------ the queue

  /** New order of the queued turns (docs/ui-api.md, "Kolejka"); every client hears each moved turn. */
  async reorderQueuedTurns(this: GatewayCore, request: ui.ReorderQueuedTurnsRequest): Promise<ui.Turn[]> {
    const rows = await coreQueue(this, (q) =>
      q.reorder({ threadId: request.threadId, ownerUserId: this[coreState].options.userId, turnIds: request.turnIds }),
    );

    const turns = rows.map(toUiTurn);

    for (const turn of turns)
      this.hub.publishThread(
        request.threadId,
        create(ui.ThreadUpdateSchema, { change: { case: "turn", value: turn } }),
      );

    return turns;
  },

  /**
   * A queued message's new text, composed like a sent one: the note of its files and its quotes (both stay), its
   * mentions checked and resolved. The revision guards the rest (the turn may change or start meanwhile).
   */
  async editQueuedTurn(this: GatewayCore, request: ui.EditQueuedTurnRequest): Promise<ui.Turn> {
    const ownerUserId = this[coreState].options.userId;
    const current = await coreQueue(this, (q) => q.queued({ turnId: request.turnId, ownerUserId }));
    const thread = await coreRun(this, (s) => s.thread(current.thread_id));
    const text = request.text;

    const { mentions, goal } = await coreMessageMentions(
      this,
      { id: thread.id, cwd: thread.cwd ?? "" },
      text,
      request.mentions,
    );

    if (goal !== undefined) throw new InvalidError("a /goal message does not wait in the queue; send it instead");
    const attachments = current.input.attachments ?? [];
    const note = attachments.length > 0 ? attachmentsNote(attachments) : "";

    const base: TurnInputJson = note
      ? { text: withAttachmentsNote(note, text), note, message: text, attachments }
      : { text };

    const input = coreComposeInput(this, thread.provider, text, mentions, base, current.input.quotes ?? []) ?? base;

    const row = await coreQueue(this, (q) =>
      q.edit({ turnId: request.turnId, ownerUserId, input, expectedRevision: request.expectedRevision }),
    );

    return corePublishQueued(this, row);
  },

  async deleteQueuedTurn(this: GatewayCore, turnId: string): Promise<ui.Turn> {
    return corePublishQueued(
      this,
      await coreQueue(this, (q) => q.remove({ turnId, ownerUserId: this[coreState].options.userId })),
    );
  },

  /** Undo of a delete: the turn is queued at its place again (and starts when it is the head of an idle thread). */
  async restoreQueuedTurn(this: GatewayCore, turnId: string): Promise<ui.Turn> {
    const row = await coreQueue(this, (q) => q.restore({ turnId, ownerUserId: this[coreState].options.userId }));
    const turn = await corePublishQueued(this, row);
    await this.pump(row.thread_id);

    return turn;
  },

  /** A queued message into the running turn now; when it cannot join, its turn is back at its place (SteerStore.queue). */
  async steerQueuedTurn(this: GatewayCore, turnId: string): Promise<{ steer: ui.Steer; turn: ui.Turn }> {
    const { steer, turn } = await coreQueue(this, (q) =>
      q.steer({ turnId, ownerUserId: this[coreState].options.userId }),
    );

    const update = await corePublishQueued(this, turn);
    await coreSendSteer(this, steer.id);

    return { steer: toUiSteer(await coreSteers(this, (s) => s.steer(steer.id))), turn: update };
  },
};
