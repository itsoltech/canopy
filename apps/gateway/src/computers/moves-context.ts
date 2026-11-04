import { type DescMethod, type Message } from "@bufbuild/protobuf";

import { computerLink as link, ui } from "@canopy/contracts";

import { Match } from "effect";

import type { GatewayCore } from "../core/core.ts";

import type { Redirects } from "./redirects.ts";

import type { ComputerStore } from "./store.ts";

/**
 * Stage 8 of docs/linked-computers.md: "Move to…" for threads and bots between directly linked computers.
 *
 * The source (the current home) coordinates a two-phase move: it freezes the thing, sends its full state to
 * the target, which stages it, and then commits in one transaction that turns its own copy into a redirect.
 * Only after that decision does the target apply the staged state. Before the decision any failure (a lost
 * link, a restart of either side, a refusal) rolls back; after it the move only rolls forward. Both sides
 * keep a durable record and settle unfinished moves whenever the link is up, so a move converges to
 * exactly one home and every message is idempotent.
 */
export const PREPARE_TIMEOUT_MS = 120_000;

export const DECIDE_TIMEOUT_MS = 15_000;

/** A staged move whose decision has not arrived: the target asks the source after this long. */
export const ASK_AFTER_MS = 3_000;

export type MovePhase = "frozen" | "prepared" | "committed" | "staged" | "decided";

export type MoveHost = {
  core: GatewayCore;
  redirects: Redirects;
  self(): { nodeId: string; name: string };
  name(nodeId: string): Promise<string>;
  /** A direct partner connected now and able to receive moves. */
  ready(nodeId: string): boolean;
  /** Why a partner cannot receive moves now, in the UI's words; empty when it can. */
  unavailable(nodeId: string): Promise<string>;
  call(nodeId: string, method: DescMethod, request: Message, signal: AbortSignal): AsyncGenerator<Message>;
  broadcast(items: link.MovedItem[]): void;
  /** Tests: interrupt a move at a phase (drop the link, restart a side). Throwing `MoveCrash` stops like a killed process. */
  hook?: (phase: MovePhase, move: { id: string; role: string }) => Promise<void>;
};

/** Thrown by a test hook: the process "dies" here, without any further step or rollback. */
export class MoveCrash extends Error {}

export const ACTIVE = ["preparing", "prepared", "committed", "aborting"];

export const ms = (date: Date | string) => BigInt(new Date(date).getTime());

export const sharedLabel = (key: string) => {
  const [kind, ...rest] = key.split(":");

  return Match.value(kind).pipe(
    Match.when("instance", () => `Provider instance ${rest.at(-1)}`),
    Match.when("models", () => `Models of ${rest.at(-1)}`),
    Match.when("project", () => "A project"),
    Match.orElse(() => `Settings: ${rest.join(" ").replace("_", " ")}`),
  );
};

/**
 * The note a moved thread's agent gets in its new session's instructions, like a bot's handoff (docs/bots.md):
 * where it came from, the task, and an excerpt of the conversation, clearly marked as incomplete.
 */
export function handoffNote(
  history: ui.ThreadSnapshot,
  where: { from: string; to: string; oldCwd: string; newCwd: string; title: string },
) {
  const messages = history.items.flatMap((i) => {
    const content = i.item?.content;

    return Match.value(content).pipe(
      Match.when({ case: "userMessage" }, (c) => [`User: ${c.value.text}`]),
      Match.when({ case: "agentMessage" }, (c) => [`Assistant: ${c.value.text}`]),
      Match.orElse(() => []),
    );
  });

  const task = history.turns.find((t) => t.messageText || t.inputText);
  const recent: string[] = [];
  let size = 0;

  for (const message of messages.slice(-30).reverse()) {
    const text = message.length > 800 ? `${message.slice(0, 800)}…` : message;

    if (size + text.length > 10_000) break;
    recent.unshift(text);
    size += text.length;
  }

  const goal =
    history.goal && !["achieved", "cancelled"].includes(history.goal.status)
      ? `\nAn open goal did not move: ${history.goal.objective.slice(0, 1000)}. It is set again only if the user asks.`
      : "";

  return (
    [
      `Handoff: this thread ("${where.title}") moved from ${where.from} to ${where.to}. Its earlier work ran in another session on ${where.from}${where.oldCwd ? `, in ${where.oldCwd}` : ""}.`,
      `That session and its files are not here. You now work in ${where.newCwd} on ${where.to}, which may differ: check the files before relying on earlier output.`,
      ...(task ? [`Original task: ${(task.messageText || task.inputText).slice(0, 2000)}`] : []),
      `Recent conversation (an excerpt; earlier messages may be missing):`,
      ...recent,
    ]
      .join("\n")
      .slice(0, 16_000) +
    goal +
    "\nContinue naturally; mention the move only if the user asks about it."
  );
}

export const movesState: unique symbol = Symbol("ComputerMoves state");

export class ComputerMovesState {
  driving = new Set<string>();

  tasks = new Set<Promise<unknown>>();

  ticking = false;

  closed = false;
  store!: ComputerStore;
  host!: MoveHost;
}
