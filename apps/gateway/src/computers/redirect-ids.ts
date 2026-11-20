import { isMessage, type DescMessage, type Message } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { isEntityId, qualifyId, splitId } from "@canopy/domain/computers";
import { Predicate } from "effect";
import type { Arguments } from "./agents-context.ts";
import { mapIds } from "./remote-ids.ts";

export type MoveKind = "thread" | "bot";

/** These reads authorize their selector within the requested thread, including its imported history. */
export function rewriteThreadRead(message: Message, threadHome: (value: string) => string) {
  if (!isMessage(message, ui.GetVisualRequestSchema) && !isMessage(message, ui.WatchThreadRequestSchema)) return false;
  const original = message.threadId;
  const next = threadHome(original);
  const thread = splitId(next);
  let changed = false;

  const selector = (value: string) => {
    if (!isEntityId(value)) return value;
    const ref = splitId(value);

    if (thread.node === ref.node) return value;
    const previous = ref.node ? qualifyId(thread.id, ref.node) : thread.id;

    if (threadHome(previous) !== next) return value;
    changed = true;

    return thread.node ? qualifyId(ref.id, thread.node) : ref.id;
  };

  if (isMessage(message, ui.GetVisualRequestSchema)) message.visualId = selector(message.visualId);
  else {
    message.beforeTurnId = selector(message.beforeTurnId);
    message.fromTurnId = selector(message.fromTurnId);
    message.beforeItemId = selector(message.beforeItemId);
    message.targetItemId = selector(message.targetItemId);

    if (
      next !== original ||
      (message.syncCursor && message.syncCursor.threadId !== next && threadHome(message.syncCursor.threadId) === next)
    ) {
      delete message.syncCursor;
      message.cursor = "";
      message.mirrorCursor = "";
      changed = true;
    }
  }

  return changed;
}

const THREAD_FIELDS = new Set([
  "thread_id",
  "thread_ids",
  "parent_thread_id",
  "fork_thread_id",
  "target_thread_id",
  "after_thread_id",
  "before_thread_id",
  "other_thread_ids",
]);

/** Only references to a movable entity can change its home. Content, cursors and operation IDs are opaque. */
export function mapMoveIds(desc: DescMessage, message: Message, map: (value: string, kind: MoveKind) => string) {
  mapIds(desc, message, (value, field, containing) => {
    // A mention, quote or sender embedded in the request never selects the RPC's destination.
    if (
      containing !== desc &&
      containing.typeName !== "canopy.ui.v1.BotComposerDraft" &&
      containing.typeName !== "canopy.ui.v1.Schedule"
    )
      return value;

    if (THREAD_FIELDS.has(field)) return map(value, "thread");

    if (field === "bot_id" || field === "bot_ids") return map(value, "bot");

    return value;
  });
}

export function movedAgentTarget(operation: string, args: Arguments) {
  if (
    !["send", "get_thread", "read_thread", "interrupt_thread", "close_thread"].includes(operation) ||
    !Predicate.isString(args["target"])
  )
    return undefined;
  const kind: MoveKind = operation === "send" && args["target_kind"] === "bot" ? "bot" : "thread";

  return { id: args["target"], kind };
}
