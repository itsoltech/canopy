import type { ui } from "@open-agents/contracts";

/**
 * Where a turn's input came from, for the timeline: from the turn's source (`source_kind` and the
 * thread or schedule behind it, kept by the gateway in its database), not from the text.
 */
export type TurnOrigin =
  | { readonly kind: "user" }
  /** spawn_thread: the first task of a side thread, from `threadId`. */
  | { readonly kind: "task"; readonly threadId: string }
  /** send_message from another thread of the tree. */
  | { readonly kind: "message"; readonly threadId: string }
  /** Answers to this agent's own ask_user: from a parent thread (`threadId`), a bot (Turn.bot_id) or you (neither). */
  | { readonly kind: "answer"; readonly threadId: string }
  /** A thread this one is following finished a turn and reports back. */
  | { readonly kind: "report"; readonly threadId: string }
  /** A side thread (interaction_route = parent) waits for this agent's answer. */
  | { readonly kind: "question"; readonly threadId: string; readonly requestId: string }
  /** Background tasks of this thread ended; the platform told the agent how (`itemIds`: their items). */
  | { readonly kind: "background_task"; readonly itemIds: readonly string[] }
  /** A schedule ran; `setBy` is the thread whose agent set it (empty: you did). */
  | { readonly kind: "schedule"; readonly scheduleId: string; readonly setBy: string }
  /** Another trigger without a known source. */
  | { readonly kind: "other"; readonly trigger: string };

export function turnOrigin(turn: ui.Turn): TurnOrigin {
  switch (turn.sourceKind) {
    case "task":
    case "message":
    case "report":
      return { kind: turn.sourceKind, threadId: turn.sourceThreadId };
    case "answer":
      return { kind: "answer", threadId: turn.sourceThreadId };
    case "question":
      return { kind: "question", threadId: turn.sourceThreadId, requestId: turn.interactionRequestId };
    case "schedule":
      return { kind: "schedule", scheduleId: turn.scheduleId, setBy: turn.sourceThreadId };
    case "background_task":
      return { kind: "background_task", itemIds: turn.backgroundItemIds };
    default:
      return turn.trigger === "user" || !turn.trigger ? { kind: "user" } : { kind: "other", trigger: turn.trigger };
  }
}

/** Label of a turn started without input (provider wake-up, recovery, goal); undefined otherwise. */
export function silentTriggerLabel(turn: ui.Turn): string | undefined {
  if (turn.inputText) return undefined;
  switch (turn.trigger) {
    case "provider":
      // Codex continues an active goal on its own; other wake-ups follow finished background work.
      return turn.goalId ? "Continuing the goal" : "Background work finished";
    case "recovery":
      return "Resumed after a restart";
    case "goal":
      return "Goal";
    default:
      return undefined;
  }
}
