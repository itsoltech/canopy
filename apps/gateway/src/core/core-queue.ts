import { create } from "@bufbuild/protobuf";
import { MentionKind, ui } from "@canopy/contracts";
import { Effect } from "effect";
import { placedAttachmentIds, relocateMentions } from "@canopy/domain";
import { QueueStore, toUiSteer, toUiTurn, type TurnRow } from "../store/index.ts";
import { coreState, InvalidError, type TurnInputJson } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { attachmentsInput } from "./core-attachments.ts";
import { coreComposeInput, coreMessageMentions } from "./core-mentions.ts";
import { mentionsFromJson } from "./mentions.ts";
import { coreSendSteer, coreSteers } from "./core-messages.ts";
import { coreRun } from "./core-broadcast.ts";
import { coreShellInput } from "./core-shell.ts";

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
   * mentions checked and resolved. A file the message had placed in its text lives with its badge: without the badge
   * it leaves the message (files never placed stay). Positions come from the editor (`mentions_complete`); an older
   * client that edits plain text and sends none gets the turn's mentions found again in the new text. The revision
   * guards the rest (the turn may change or start meanwhile).
   */
  async editQueuedTurn(this: GatewayCore, request: ui.EditQueuedTurnRequest): Promise<ui.Turn> {
    const ownerUserId = this[coreState].options.userId;
    const current = await coreQueue(this, (q) => q.queued({ turnId: request.turnId, ownerUserId }));
    const thread = await coreRun(this, (s) => s.thread(current.thread_id));
    const text = request.text;

    const given =
      request.mentionsComplete || request.mentions.length > 0
        ? request.mentions
        : relocateMentions(
            current.input.message ?? current.input.text ?? "",
            mentionsFromJson(current.input.mentions),
            text,
          );

    const { mentions, goal } = await coreMessageMentions(
      this,
      { id: thread.id, cwd: thread.cwd ?? "" },
      text,
      given,
      new Map((current.input.attachments ?? []).map((a) => [a.id, { name: a.name, kind: a.kind }])),
    );

    if (goal !== undefined) throw new InvalidError("a /goal message does not wait in the queue; send it instead");
    const wasPlaced = new Set(placedAttachmentIds(mentionsFromJson(current.input.mentions)));
    const placed = new Set(mentions.filter((m) => m.kind === MentionKind.ATTACHMENT).map((m) => m.name));
    const attachments = (current.input.attachments ?? []).filter((a) => !wasPlaced.has(a.id) || placed.has(a.id));

    if (!text.trim() && attachments.length === 0 && !current.input.quotes?.length)
      throw new InvalidError("message is empty");

    const base: TurnInputJson = attachments.length > 0 ? attachmentsInput(attachments, text, mentions) : { text };

    const input =
      coreShellInput(text, Boolean(attachments.length || current.input.quotes?.length || request.mentions.length)) ??
      coreComposeInput(this, thread.provider, text, mentions, base, current.input.quotes ?? []) ??
      base;

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
