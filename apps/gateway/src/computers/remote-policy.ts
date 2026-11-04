import { isMessage, type DescMessage, type Message, type MessageShape } from "@bufbuild/protobuf";

import { Code, ConnectError } from "@connectrpc/connect";

import { computerLink as link, ui } from "@canopy/contracts";

/** Explicit home operations for threads and bots, plus capability-gated internal services.
 * Credential and connector administration are never exposed through this allowlist. */
export const SERVED = new Set([
  "GetOverview",
  "WatchOverview",
  "ListThreads",
  "GetThread",
  "WatchThread",
  "CreateThread",
  "SendMessage",
  "InterruptThread",
  "AnswerInteraction",
  "UpdateThread",
  "RegenerateTitle",
  "SetGoal",
  "StopBackgroundTask",
  "MarkThreadSeen",
  "SetThreadRead",
  "SetThreadArchived",
  "DeleteThread",
  "RestoreThread",
  "ListModels",
  "ListDirectory",
  "GetAttachment",
  "UploadAttachment",
  "GetThreadBlob",
  "ReorderQueuedTurns",
  "EditQueuedTurn",
  "DeleteQueuedTurn",
  "RestoreQueuedTurn",
  "SteerQueuedTurn",
  "ListMentionCatalog",
  "SearchFiles",
  "WatchThreadMirror",
  "PushSharedConfig",
  "ListBots",
  "GetBot",
  "WatchBotConversation",
  "SendBotMessage",
  "AnswerBotApproval",
  "UpdateBot",
  "InterruptBot",
  "RetryBot",
  "MarkBotRead",
  "ArchiveBot",
  "UnarchiveBot",
  "DeleteBot",
  "ReadBotExchange",
  "SetBotRoutineEnabled",
  "DeleteBotRoutine",
  "CancelBotReminder",
  "WatchBotMirror",
  "CallAgentBus",
  "GetBotProviderInstances",
  "PrepareMove",
  "DecideMove",
  "MoveOutcome",
  "InspectMove",
]);

/** Stage 8: the two sides of a move, direct partners only (never relayed). */
export const MOVE_METHODS = new Set(["PrepareMove", "DecideMove", "MoveOutcome", "InspectMove"]);

export const methodNamed = (name: string) =>
  ui.GatewayService.methods.find((m) => m.name === name) ??
  link.ThreadMirrorService.methods.find((m) => m.name === name) ??
  link.SharedConfigService.methods.find((m) => m.name === name) ??
  link.LinkedAgentsService.methods.find((m) => m.name === name) ??
  link.ComputerMoveService.methods.find((m) => m.name === name);

/** Link messages have already been decoded; verify their descriptor before accessing a concrete message. */
export function linkedMessage<D extends DescMessage>(desc: D, message: Message): MessageShape<D> {
  if (!isMessage(message, desc)) throw new ConnectError("Unexpected linked message type", Code.Internal);

  return message;
}

/** Stage 8: a call named things that moved to another computer. The caller follows the redirect; the items cross relays. */
export class MovedError extends ConnectError {
  constructor(
    readonly items: link.MovedItem[],
    message = `Moved to ${items[0]?.homeName || "another computer"}`,
  ) {
    super(message, Code.FailedPrecondition);
  }
}

/** ConnectError's `instanceof` matches any ConnectError, so moved errors are told apart by their items. */
export const movedItems = (cause: unknown): link.MovedItem[] | undefined =>
  cause instanceof ConnectError &&
  "items" in cause &&
  Array.isArray(cause.items) &&
  cause.items.length &&
  cause.items.every((item): item is link.MovedItem => isMessage(item, link.MovedItemSchema))
    ? cause.items
    : undefined;

export const BOT_METHODS = new Set([
  "ListBots",
  "GetBot",
  "WatchBotConversation",
  "SendBotMessage",
  "AnswerBotApproval",
  "UpdateBot",
  "InterruptBot",
  "RetryBot",
  "MarkBotRead",
  "ArchiveBot",
  "UnarchiveBot",
  "DeleteBot",
  "ReadBotExchange",
  "SetBotRoutineEnabled",
  "DeleteBotRoutine",
  "CancelBotReminder",
  "WatchBotMirror",
  "GetBotProviderInstances",
]);
