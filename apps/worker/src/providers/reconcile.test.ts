import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ItemSchema, ItemStatus, TurnEndSource, TurnOutcome } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import type { OpenTurn } from "../journal/index.ts";
import { readClaudeTurn } from "./claude/transcript.ts";
import { readCodexTurn, threadItem } from "./codex/transcript.ts";
import { reconcileEvents, WORKER_RESTARTED } from "./reconcile.ts";

const tempDir = tempDirs();

/**
 * Harness-truth reconciliation (docs/durability.md, "Rekoncyliacja z transkryptu harnessu") on recorded transcripts
 * (fixtures/: a Codex rollout with four turns, Claude Code session transcripts; trimmed, no real paths or secrets).
 */

const fixture = (name: string) => join(import.meta.dir, "fixtures", name);

/** A Claude config dir with the session transcript where Claude Code keeps it; returns the home and the content. */
function claudeHome(sessionId: string, content: string): string {
  const home = tempDir("canopy-claude-");
  mkdirSync(join(home, "projects", "-work-app"), { recursive: true });
  writeFileSync(join(home, "projects", "-work-app", `${sessionId}.jsonl`), content);
  return home;
}

const byteOffset = (content: string, marker: string) => Buffer.byteLength(content.slice(0, content.lastIndexOf("\n", content.indexOf(marker)) + 1));

type ItemLike = { readonly itemId?: string | undefined; readonly status?: ItemStatus | undefined; readonly content?: { readonly case?: string | undefined } | undefined };
const summary = (items: readonly ItemLike[]) => items.map((i) => [i.itemId, ItemStatus[i.status ?? 0], i.content?.case]);

describe("Codex rollout", () => {
  test("a turn the harness completed: every item under its live id, the final message, usage, completed", async () => {
    const record = await readCodexTurn(fixture("codex-rollout.jsonl"), 0, "turn-done", "platform-turn");
    expect(record?.end).toMatchObject({ outcome: TurnOutcome.COMPLETED, providerTurnRef: "turn-done", usage: { inputTokens: 1200n, outputTokens: 50n, cachedInputTokens: 200n } });
    expect(summary(record!.items)).toEqual([
      ["user-item-1", "COMPLETED", "userMessage"],
      ["msg_commentary", "COMPLETED", "agentMessage"],
      ["call_cell_1", "COMPLETED", "toolCall"],
      ["exec-cmd-1", "COMPLETED", "commandExecution"],
      ["msg_final", "COMPLETED", "agentMessage"],
    ]);
    const command = record!.items.find((i) => i.itemId === "exec-cmd-1")!.content;
    expect(command).toEqual({
      case: "commandExecution",
      value: { command: "/usr/bin/bash -lc 'sleep 2; echo slept-ok'", cwd: "/work/app", output: "slept-ok\n", exitCode: 0, durationMs: 2005n },
    });
    const user = record!.items[0]!.content;
    expect(user).toMatchObject({ case: "userMessage", value: { clientId: "01a19900-0000-7000-8000-000000000001" } });
  });

  test("a turn cut off mid-command has no end; the shell call without an item still shows", async () => {
    const record = await readCodexTurn(fixture("codex-rollout.jsonl"), 0, "turn-cut", "platform-turn");
    expect(record?.end).toBeUndefined();
    expect(summary(record!.items)).toEqual([
      ["user-item-2", "COMPLETED", "userMessage"],
      ["rs_1", "COMPLETED", "reasoning"],
      ["call_shell_1", "COMPLETED", "commandExecution"],
    ]);
  });

  test("an error Codex recorded fails the turn in the harness, with its message and code", async () => {
    const record = await readCodexTurn(fixture("codex-rollout.jsonl"), 0, "turn-401", "platform-turn");
    expect(record?.end).toMatchObject({
      outcome: TurnOutcome.FAILED,
      source: TurnEndSource.HARNESS,
      errorCode: "http_connection_failed:401",
      reason: expect.stringContaining("401 Unauthorized"),
    });
  });

  test("an abort the client asked for is the user's; the command keeps its real end", async () => {
    const record = await readCodexTurn(fixture("codex-rollout.jsonl"), 0, "turn-stop", "platform-turn");
    expect(record?.end).toMatchObject({ outcome: TurnOutcome.INTERRUPTED, source: TurnEndSource.USER, reason: "interrupted" });
    expect(summary(record!.items)).toEqual([["exec-cmd-2", "FAILED", "commandExecution"]]);
  });

  test("without the Codex turn id, the first turn after the offset is the turn", async () => {
    const content = readFileSync(fixture("codex-rollout.jsonl"), "utf8");
    const record = await readCodexTurn(fixture("codex-rollout.jsonl"), byteOffset(content, '"turn_id":"turn-401"'), "", "platform-turn");
    expect(record?.end?.providerTurnRef).toBe("turn-401");
    expect(await readCodexTurn(fixture("missing.jsonl"), 0, "turn-done", "platform-turn")).toBeUndefined();
  });

  test("unknown rollout item types are kept whole", () => {
    expect(threadItem({ type: "HookPrompt", id: "h1", text: "x" })).toMatchObject({ type: "hookPrompt", id: "h1" });
    expect(threadItem({ type: "Extension", kind: "web.search", id: "w1", query: "q" })).toMatchObject({ type: "webSearch", query: "q" });
  });
});

describe("Claude session transcript", () => {
  const content = readFileSync(fixture("claude-session.jsonl"), "utf8");
  const home = claudeHome("5e55-1", content);

  test("a turn the harness completed: blocks under their live ids, tool results, completed", async () => {
    const record = await readClaudeTurn(home, "5e55-1", 0);
    // The whole file is read from 0 here, so the second (cut) turn's tool call is in it too: only the first turn.
    const first = await readClaudeTurn(claudeHome("5e55-2", content.slice(0, content.indexOf('{"type":"last-prompt"'))), "5e55-2", 0);
    expect(first?.end).toMatchObject({ outcome: TurnOutcome.COMPLETED, providerTurnRef: "as-4" });
    expect(summary(first!.items)).toEqual([
      ["msg_A:0", "COMPLETED", "reasoning"],
      ["msg_A:1", "COMPLETED", "agentMessage"],
      ["toolu_1", "COMPLETED", "commandExecution"],
      ["msg_B:0", "COMPLETED", "agentMessage"],
    ]);
    expect(first!.items[2]!.content).toEqual({ case: "commandExecution", value: { command: "sleep 2; echo slept-ok", output: "slept-ok" } });
    expect(record?.end).toBeUndefined();
  });

  test("a turn cut off while a tool runs has no end and the tool stays open", async () => {
    const record = await readClaudeTurn(home, "5e55-1", byteOffset(content, "Now run sleep 40."));
    expect(record?.end).toBeUndefined();
    expect(summary(record!.items)).toEqual([["toolu_2", "IN_PROGRESS", "commandExecution"]]);
  });

  test("an API error fails the turn in the harness; an interruption on request is the user's", async () => {
    const errors = readFileSync(fixture("claude-session-error.jsonl"), "utf8");
    const limit = await readClaudeTurn(claudeHome("e1", `${errors.split("\n").slice(0, 2).join("\n")}\n`), "e1", 0);
    expect(limit?.end).toMatchObject({ outcome: TurnOutcome.FAILED, source: TurnEndSource.HARNESS, errorCode: "usage_limit_reached", reason: expect.stringContaining("session limit") });
    const stopped = await readClaudeTurn(claudeHome("e2", errors), "e2", byteOffset(errors, "Try a tool"));
    expect(stopped?.end).toMatchObject({ outcome: TurnOutcome.INTERRUPTED, source: TurnEndSource.USER });
    expect(summary(stopped!.items)).toEqual([["toolu_9", "FAILED", "commandExecution"]]);
    expect(await readClaudeTurn(home, "no-such-session", 0)).toBeUndefined();
  });
});

describe("reconcileEvents", () => {
  const item = (itemId: string, status: ItemStatus, text = itemId) => create(ItemSchema, { itemId, status, content: { case: "agentMessage", value: { text } } });
  const open = (items: OpenTurn["items"], interruptRequested = false): OpenTurn => ({
    threadId: "thread",
    turnId: "turn",
    harness: { harness: "codex", transcript: "/rollout.jsonl", sessionId: "c", offset: 0, providerTurn: "turn-done" },
    items,
    interruptRequested,
  });

  test("journals only what is missing, in the harness's order, then the harness's end", async () => {
    const record = await readCodexTurn(fixture("codex-rollout.jsonl"), 0, "turn-done", "turn");
    // The worker had forwarded the user message and the commentary; the command was running; the final message never came.
    const events = reconcileEvents(
      open([
        { item: item("user-item-1", ItemStatus.COMPLETED), done: true },
        { item: item("msg_commentary", ItemStatus.COMPLETED), done: true },
        { item: item("exec-cmd-1", ItemStatus.IN_PROGRESS), done: false },
      ]),
      record,
      WORKER_RESTARTED,
    );
    expect(events.map((e) => [e.body?.case, e.body?.case === "itemCompleted" ? e.body.value.item?.itemId : undefined, e.turnId])).toEqual([
      ["itemCompleted", "call_cell_1", "turn"],
      ["itemCompleted", "exec-cmd-1", "turn"],
      ["itemCompleted", "msg_final", "turn"],
      ["turnFinished", undefined, "turn"],
    ]);
    expect(events.at(-1)?.body).toMatchObject({ case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED, providerTurnRef: "turn-done" } });
    // Run again on the same journal state: the same events (the gateway deduplicates by item id; nothing new appears).
    expect(reconcileEvents(open([{ item: item("user-item-1", ItemStatus.COMPLETED), done: true }]), record, WORKER_RESTARTED).length).toBe(5);
  });

  test("no end in the transcript: open items are interrupted and the turn ends with the cause", async () => {
    const record = await readCodexTurn(fixture("codex-rollout.jsonl"), 0, "turn-cut", "turn");
    const events = reconcileEvents(open([{ item: item("exec-live", ItemStatus.IN_PROGRESS), done: false }]), record, WORKER_RESTARTED);
    const ended = events.filter((e) => e.body?.case === "itemCompleted").map((e) => (e.body?.case === "itemCompleted" ? [e.body.value.item?.itemId, e.body.value.item?.status] : []));
    expect(ended).toContainEqual(["exec-live", ItemStatus.INTERRUPTED]);
    expect(events.at(-1)?.body).toMatchObject({ case: "turnFinished", value: { outcome: TurnOutcome.INTERRUPTED, source: TurnEndSource.SYSTEM, reason: "worker restarted mid-turn" } });
  });

  test("an interruption the harness recorded is the user's only when the platform asked for it", async () => {
    // Codex aborts the turn ("interrupted") also when its worker dies and its input closes.
    const record = await readCodexTurn(fixture("codex-rollout.jsonl"), 0, "turn-stop", "turn");
    expect(reconcileEvents(open([], true), record, WORKER_RESTARTED).at(-1)?.body).toMatchObject({
      case: "turnFinished",
      value: { outcome: TurnOutcome.INTERRUPTED, source: TurnEndSource.USER, reason: "interrupted" },
    });
    expect(reconcileEvents(open([], false), record, WORKER_RESTARTED).at(-1)?.body).toMatchObject({
      case: "turnFinished",
      value: { outcome: TurnOutcome.INTERRUPTED, source: TurnEndSource.SYSTEM, reason: "worker restarted mid-turn (the harness stopped the turn: interrupted)" },
    });
  });

  test("no transcript at all: everything open ends, the turn ends with the cause", () => {
    const events = reconcileEvents(open([{ item: item("a", ItemStatus.IN_PROGRESS), done: false }, { item: item("b", ItemStatus.COMPLETED), done: true }]), undefined, {
      outcome: TurnOutcome.FAILED,
      source: TurnEndSource.HARNESS,
      reason: "harness process exited (code 1)",
      errorCode: "process_exit",
    });
    expect(events).toHaveLength(2);
    expect(events[0]?.body).toMatchObject({ case: "itemCompleted", value: { item: { itemId: "a", status: ItemStatus.INTERRUPTED } } });
    expect(events[1]?.body).toMatchObject({ case: "turnFinished", value: { outcome: TurnOutcome.FAILED, source: TurnEndSource.HARNESS, errorCode: "process_exit" } });
  });
});
