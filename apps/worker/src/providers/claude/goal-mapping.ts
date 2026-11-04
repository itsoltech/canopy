import { Schema } from "effect";
import type { JsonObject } from "@canopy/domain";
import type { ThreadEventInit } from "../../journal/index.ts";

type Block = JsonObject;

/** Evaluator verdict of a /goal Stop hook (goal_status attachment in the session transcript). */
export interface GoalVerdict {
  readonly met: boolean;
  readonly failed?: boolean;
  readonly sentinel?: boolean;
  readonly condition: string;
  readonly reason?: string;
  readonly iterations?: number;
}

export const ActiveGoal = Schema.Struct({
  type: Schema.String,
  value: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        condition: Schema.optionalKey(Schema.String),
        iterations: Schema.optionalKey(Schema.Number),
        last_reason: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});

/** A notification consumed without a model turn (notably an old task's stop notice on resume). */
type TurnMessage = {
  type: string;
  subtype?: string;
  is_error?: boolean;
  num_turns?: number;
  origin?: { kind: string };
};

export function isTaskNotificationAck(message: TurnMessage): boolean {
  return (
    message.type === "result" &&
    message.subtype === "success" &&
    !message.is_error &&
    message.num_turns === 0 &&
    message.origin?.kind === "task-notification"
  );
}

/** Messages starting a provider turn. init must reserve the turn before a slow model's first output arrives. */
export function startsTurn(message: TurnMessage): boolean {
  return (
    !isTaskNotificationAck(message) &&
    ((message.type === "system" && message.subtype === "init") ||
      message.type === "assistant" ||
      message.type === "stream_event" ||
      message.type === "result")
  );
}

/** The local answer of /goal (a synthetic assistant message): goal set or cleared. */
export function goalAnswer(blocks: readonly Block[]): NonNullable<ThreadEventInit["body"]> | undefined {
  const text = blocks.map((b) => (b["type"] === "text" ? String(b["text"]) : "")).join("");
  const set = /^Goal set: ([\s\S]+)$/.exec(text)?.[1];

  if (set) return { case: "goalState", value: { nativeStatus: "active", objective: set, condition: set } };
  const cleared = /^Goal cleared: ([\s\S]+)$/.exec(text)?.[1];

  if (cleared)
    return {
      case: "goalState",
      value: { nativeStatus: "cleared", cleared: true, objective: cleared, condition: cleared },
    };

  return undefined;
}
