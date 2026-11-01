import type { ui } from "@open-agents/contracts";

/**
 * Where a turn's input came from, for the timeline. The contract carries `trigger` and `hops`; who sent
 * an agent-bus or interaction turn is only in the platform's message envelope ("[open-agents] …",
 * apps/gateway agent-bus.ts / scheduler.ts), so it is read from there. An envelope that does not
 * match (older or changed wording) falls back to the trigger alone with the full text.
 */
export type TurnOrigin =
  | { readonly kind: "user"; readonly body: string }
  /** spawn_thread: the first task of a side thread. */
  | { readonly kind: "task"; readonly threadId: string; readonly title: string; readonly body: string }
  /** send_message from another thread of the tree. */
  | { readonly kind: "message"; readonly threadId: string; readonly title: string; readonly body: string }
  /** A thread this one is following finished a turn; `body` is its last message. */
  | { readonly kind: "report"; readonly threadId: string; readonly title: string; readonly status: string; readonly body: string }
  /** A side thread (interaction_route = parent) waits for this agent's answer. */
  | { readonly kind: "question"; readonly threadId: string; readonly title: string; readonly request: string; readonly tool: string; readonly body: string }
  | { readonly kind: "schedule"; readonly label: string; readonly delayed: boolean; readonly body: string }
  /** Another trigger without a recognised envelope. */
  | { readonly kind: "other"; readonly trigger: string; readonly body: string };

const TASK = /^\[open-agents\] Task from the thread "(.*)" \(thread_id: ([\w-]+)\)\.[^\n]*\n\n([\s\S]*)$/;
const MESSAGE = /^\[open-agents\] Message from the thread "(.*)" \(thread_id: ([\w-]+)\):\n\n([\s\S]*)$/;
const REPORT = /^\[open-agents\] The (?:side )?thread "(.*)" \(thread_id: ([\w-]+)\) finished a turn: (\w+)\.\nIts last message:\n\n([\s\S]*)$/;
const QUESTION = /^\[open-agents\] Your side thread "(.*)" \(thread_id: ([\w-]+)\) is waiting for your answer\.\n([\s\S]*)$/;
const SCHEDULE = /^\[open-agents\] Scheduled (.+?) \(schedule_id: [^,)]+(, delayed)?\):\n\n([\s\S]*)$/;

const field = (text: string, name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(text)?.[1] ?? "";

export function turnOrigin(trigger: string, text: string): TurnOrigin {
  if (trigger === "user") return { kind: "user", body: text };
  let match: RegExpExecArray | null;
  if (trigger === "agent_bus") {
    if ((match = TASK.exec(text))) return { kind: "task", title: match[1]!, threadId: match[2]!, body: match[3]! };
    if ((match = MESSAGE.exec(text))) return { kind: "message", title: match[1]!, threadId: match[2]!, body: match[3]! };
    if ((match = REPORT.exec(text))) return { kind: "report", title: match[1]!, threadId: match[2]!, status: match[3]!, body: match[4]! };
  }
  if (trigger === "interaction" && (match = QUESTION.exec(text))) {
    return { kind: "question", title: match[1]!, threadId: match[2]!, request: field(match[3]!, "kind"), tool: field(match[3]!, "tool"), body: match[3]! };
  }
  if (trigger === "schedule" && (match = SCHEDULE.exec(text))) {
    const label = match[1]!;
    return { kind: "schedule", label: label === "wake-up" ? "Scheduled wake-up" : `Scheduled ${label}`, delayed: Boolean(match[2]), body: match[3]! };
  }
  return { kind: "other", trigger, body: text };
}

/** Label of a turn started without input (provider wake-up, recovery, goal); undefined otherwise. */
export function silentTriggerLabel(turn: ui.Turn): string | undefined {
  if (turn.inputText) return undefined;
  switch (turn.trigger) {
    case "provider":
      return "Background work finished";
    case "recovery":
      return "Resumed after a restart";
    case "goal":
      return "Goal";
    default:
      return undefined;
  }
}
