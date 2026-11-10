import type { ServerNotification } from "@canopy/codex-protocol";
import type { CodexThreadContext, Entry } from "./thread-types.ts";

/** Background commands legitimately emit after completion. Late model output or lifecycle events do not. */
export function warnLateEvent(ctx: CodexThreadContext, entry: Entry, notification: ServerNotification): void {
  const turnId = (() => {
    switch (notification.method) {
      case "turn/started":
      case "turn/completed":
        return notification.params.turn.id;
      case "item/started":
      case "item/completed":
        return notification.params.item.type === "commandExecution" ? undefined : notification.params.turnId;
      case "item/agentMessage/delta":
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        return notification.params.turnId;
      default:
        return undefined;
    }
  })();

  if (!turnId || !entry.finishedTurns.has(turnId) || entry.warnedLateTurns.has(turnId)) return;
  entry.warnedLateTurns.add(turnId);
  ctx.options.log?.(
    JSON.stringify({
      event: "codex_late_turn_event",
      threadId: entry.platformId,
      turnId: entry.codexToPlatform.get(turnId),
      providerTurnId: turnId,
      method: notification.method,
    }),
  );
}
