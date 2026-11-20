import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ItemSchema, ItemStatus, TurnEndSource, TurnOutcome } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import type { OpenTurn } from "../journal/index.ts";
import { readClaudeTurn } from "./claude/transcript.ts";
import { readCodexTurn, threadItem } from "./codex/transcript.ts";
import { readHarnessRecord, reconcileEvents, WORKER_RESTARTED } from "./reconcile.ts";

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

const byteOffset = (content: string, marker: string) =>
  Buffer.byteLength(content.slice(0, content.lastIndexOf("\n", content.indexOf(marker)) + 1));

type ItemLike = {
  readonly itemId?: string | undefined;
  readonly status?: ItemStatus | undefined;
  readonly content?: { readonly case?: string | undefined } | undefined;
};

const summary = (items: readonly ItemLike[]) =>
  items.map((i) => [i.itemId, ItemStatus[i.status ?? 0], i.content?.case]);

function movedCodexRollout() {
  const home = tempDir("canopy-reconcile-codex-");
  const sessionId = "a682a9b3-1881-4ec4-b46d-b58bf428ab1f";
  const name = `rollout-2026-11-01T10-00-00-${sessionId}_30f3b8dd-09c0-4e02-9b9b-34045bb69fde.jsonl`;
  const active = join(home, "sessions", "2026", "11", "01", name);
  const archived = join(home, "archived_sessions", name);

  const content = readFileSync(fixture("codex-rollout.jsonl"), "utf8")
    .replace("c0dex-thread", sessionId)
    .replace("/work/app", "/work/żółw");

  mkdirSync(join(archived, ".."));

  const open: OpenTurn = {
    threadId: "canopy-thread",
    turnId: "canopy-turn",
    items: [],
    interruptRequested: false,
    harness: {
      harness: "codex",
      transcript: active,
      sessionId,
      providerTurn: "",
      offset: byteOffset(content, '"turn_id":"turn-401"'),
    },
  };

  return { active, archived, content, open };
}

describe("Codex rollout", () => {
  test("journal recovery uses the same byte offset after Codex archives and compresses the rollout", async () => {
    const { active, archived, content, open } = movedCodexRollout();
    const compressed = Bun.zstdCompressSync(Buffer.from(content));
    writeFileSync(`${archived}.zst`, compressed);

    const record = await readHarnessRecord(open);
    expect(record?.end).toMatchObject({ outcome: TurnOutcome.FAILED, providerTurnRef: "turn-401" });
    expect(existsSync(active)).toBe(false);
    expect(existsSync(archived)).toBe(false);
    expect(readFileSync(`${archived}.zst`)).toEqual(Buffer.from(compressed));
  });

  test("journal recovery prefers the plain rollout if native publication left both archive forms", async () => {
    const { archived, content, open } = movedCodexRollout();
    writeFileSync(archived, content);
    writeFileSync(`${archived}.zst`, "invalid Zstandard data");

    expect((await readHarnessRecord(open))?.end?.providerTurnRef).toBe("turn-401");
  });

  test("journal recovery follows the exact native name back to sessions after unarchive", async () => {
    const { active, archived, content, open } = movedCodexRollout();

    mkdirSync(join(active, ".."), { recursive: true });
    writeFileSync(active, content);

    if (!open.harness) throw new Error("Missing fixture harness");

    expect(
      (await readHarnessRecord({ ...open, harness: { ...open.harness, transcript: archived } }))?.end,
    ).toMatchObject({
      outcome: TurnOutcome.FAILED,
      providerTurnRef: "turn-401",
    });
  });

  test.skipIf(process.platform === "win32")("journal recovery rejects a linked compressed archive", async () => {
    const { archived, content, open } = movedCodexRollout();
    const other = join(tempDir("canopy-reconcile-other-codex-"), "other.jsonl.zst");
    writeFileSync(other, Bun.zstdCompressSync(Buffer.from(content)));
    symlinkSync(other, `${archived}.zst`);

    expect(await readHarnessRecord(open)).toBeUndefined();
  });

  test("journal recovery cannot infer completion from an invalid compressed rollout", async () => {
    const { archived, open } = movedCodexRollout();

    writeFileSync(`${archived}.zst`, "invalid Zstandard data");

    expect(await readHarnessRecord(open)).toBeUndefined();
  });

  test("a turn the harness completed: every item under its live id, the final message, usage, completed", async () => {
    const record = await readCodexTurn(fixture("codex-rollout.jsonl"), 0, "turn-done", "platform-turn");
    expect(record?.end).toMatchObject({
      outcome: TurnOutcome.COMPLETED,
      providerTurnRef: "turn-done",
    });
    expect(record?.consumedUsages).toEqual([]);
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
      value: {
        command: "/usr/bin/bash -lc 'sleep 2; echo slept-ok'",
        cwd: "/work/app",
        output: "slept-ok\n",
        exitCode: 0,
        durationMs: 2005n,
      },
    });
    const user = record!.items[0]!.content;
    expect(user).toMatchObject({ case: "userMessage", value: { clientId: "01a19900-0000-7000-8000-000000000001" } });
  });

  test("bot connector image bytes are omitted from recovered Codex tool output", async () => {
    const path = join(tempDir("canopy-rollout-bot-image-"), "rollout.jsonl");
    const text = { type: "text", text: 'Downloaded attachment "report.png" [file-ref]' };
    const image = { type: "image", data: "dGVzdCBpbWFnZSBwYXlsb2Fk", mimeType: "image/png" };
    const result = { content: [text, image] };

    const tool = {
      type: "McpToolCall",
      id: "slack-tool-call",
      server: "canopy",
      tool: "slack_download",
      status: "completed",
      result,
    };

    const records = [
      { type: "event_msg", payload: { type: "task_started", turn_id: "bot-turn" } },
      { type: "event_msg", payload: { type: "item_completed", turn_id: "bot-turn", item: tool } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "bot-turn" } },
    ];

    writeFileSync(path, records.map((entry) => JSON.stringify(entry)).join("\n"));
    const record = await readCodexTurn(path, 0, "bot-turn", "platform-turn");
    expect(record?.items[0]?.content).toMatchObject({
      case: "toolCall",
      value: { output: JSON.stringify([text]) },
    });
    expect(threadItem({ ...tool, server: "canopy_connectors" })).toMatchObject({ result });
  });

  test("recovered consumption subtracts earlier turns and counts reasoning only inside output", async () => {
    const path = join(tempDir("canopy-rollout-usage-"), "rollout.jsonl");

    const tokenCount = (input: number, output: number) => ({
      input_tokens: input,
      output_tokens: output,
      reasoning_output_tokens: 2,
      total_tokens: input + output,
    });

    const records = [
      { type: "turn_context", payload: { turn_id: "old" } },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          model: "served-model",
          info: { total_token_usage: tokenCount(1000, 100), last_token_usage: tokenCount(1000, 100) },
        },
      },
      { type: "turn_context", payload: { turn_id: "new" } },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          model: "served-model",
          info: { total_token_usage: tokenCount(1011, 107), last_token_usage: tokenCount(11, 7) },
        },
      },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "new" } },
    ];

    writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const record = await readCodexTurn(path, 0, "new", "platform");

    expect(record?.consumedUsages).toMatchObject([{ model: "served-model", inputTokens: 11n, outputTokens: 7n }]);
  });

  test("crash recovery keeps the serving model across reroutes and skips ambiguous requested-model totals", async () => {
    const path = join(tempDir("canopy-rollout-crash-usage-"), "rollout.jsonl");
    const counters = { input_tokens: 11, output_tokens: 7, total_tokens: 18 };
    const start = { type: "turn_context", payload: { turn_id: "new", model: "requested-model" } };

    const count = {
      type: "event_msg",
      payload: {
        type: "token_count",
        model: "served-model",
        info: { total_token_usage: counters, last_token_usage: counters },
      },
    };

    writeFileSync(path, `${JSON.stringify(start)}\n${JSON.stringify(count)}\n`);
    const record = await readCodexTurn(path, 0, "new", "platform");

    expect(record?.end).toBeUndefined();
    expect(record?.consumedUsages).toMatchObject([{ model: "served-model", inputTokens: 11n }]);

    const usageEvents = reconcileEvents(
      { threadId: "thread", turnId: "platform", items: [], interruptRequested: false },
      record,
      WORKER_RESTARTED,
    );

    expect(usageEvents.map((event) => event.body?.case)).toEqual(["usageUpdated", "turnFinished"]);
    expect(usageEvents[0]?.body).toMatchObject({ case: "usageUpdated", value: { usage: { model: "served-model" } } });
    expect(usageEvents[1]?.body).not.toHaveProperty("value.usage");

    const ambiguous = { ...count, payload: { ...count.payload, model: undefined } };
    writeFileSync(path, `${JSON.stringify(start)}\n${JSON.stringify(ambiguous)}\n`);
    expect((await readCodexTurn(path, 0, "new", "platform"))?.consumedUsages).toEqual([]);
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
    expect(record?.end).toMatchObject({
      outcome: TurnOutcome.INTERRUPTED,
      source: TurnEndSource.USER,
      reason: "interrupted",
    });
    expect(summary(record!.items)).toEqual([["exec-cmd-2", "FAILED", "commandExecution"]]);
  });

  test("without the Codex turn id, the first turn after the offset is the turn", async () => {
    const content = readFileSync(fixture("codex-rollout.jsonl"), "utf8");

    const record = await readCodexTurn(
      fixture("codex-rollout.jsonl"),
      byteOffset(content, '"turn_id":"turn-401"'),
      "",
      "platform-turn",
    );

    expect(record?.end?.providerTurnRef).toBe("turn-401");
    expect(await readCodexTurn(fixture("missing.jsonl"), 0, "turn-done", "platform-turn")).toBeUndefined();
  });

  test("unknown rollout item types are kept whole", () => {
    expect(threadItem({ type: "HookPrompt", id: "h1", text: "x" })).toMatchObject({ type: "hookPrompt", id: "h1" });
    expect(threadItem({ type: "Extension", kind: "web.search", id: "w1", query: "q" })).toMatchObject({
      type: "webSearch",
      query: "q",
    });
  });

  test("unrelated records and a null command duration preserve the recovered turn and an empty error", async () => {
    const path = join(tempDir("canopy-rollout-"), "rollout.jsonl");

    const records = [
      null,
      { type: "metadata", payload: [] },
      { type: "turn_context", payload: { turn_id: "turn" } },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "turn",
          item: { type: "CommandExecution", id: "cmd", command: "pwd", duration: null },
        },
      },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn", error: { message: "" } } },
    ];

    writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const record = await readCodexTurn(path, 0, "turn", "platform-turn");

    expect(summary(record!.items)).toEqual([["cmd", "COMPLETED", "commandExecution"]]);
    expect(record!.items[0]!.content).toMatchObject({ case: "commandExecution", value: { command: "pwd" } });
    expect(record?.end).toMatchObject({ outcome: TurnOutcome.FAILED, reason: "" });
  });
});

describe("Claude session transcript", () => {
  test("a durable assistant response recovers consumption without a terminal outcome", async () => {
    const sessionId = "usage-crash";

    const message = {
      type: "assistant",
      uuid: "one",
      message: {
        id: "response",
        model: "actual-model",
        usage: { input_tokens: 11, output_tokens: 7 },
        content: [{ type: "text", text: "partial" }],
        stop_reason: null,
      },
    };

    const home = claudeHome(sessionId, `${JSON.stringify(message)}\n${JSON.stringify({ ...message, uuid: "two" })}\n`);
    const record = await readClaudeTurn(home, sessionId, 0);

    expect(record?.end).toBeUndefined();
    expect(record?.consumedUsages).toMatchObject([{ model: "actual-model", inputTokens: 11n, outputTokens: 7n }]);

    const events = reconcileEvents(
      { threadId: "thread", turnId: "platform", items: [], interruptRequested: false },
      record,
      WORKER_RESTARTED,
    );

    expect(events.at(-2)?.body).toMatchObject({ case: "usageUpdated", value: { usage: { model: "actual-model" } } });
    expect(events.at(-1)?.body?.case).toBe("turnFinished");
  });

  const content = readFileSync(fixture("claude-session.jsonl"), "utf8");
  const home = claudeHome("5e55-1", content);

  test("unrelated metadata and sidechain messages do not prevent recovery", async () => {
    const skipped = [
      null,
      { type: "metadata", message: "not an assistant message" },
      { type: "assistant", isSidechain: true, message: { content: 42 } },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");

    const transcript = `${skipped}\n${content.slice(0, content.indexOf('{"type":"last-prompt"'))}`;
    const recovered = await readClaudeTurn(claudeHome("mixed", transcript), "mixed", 0);

    expect(recovered?.end).toMatchObject({ outcome: TurnOutcome.COMPLETED, providerTurnRef: "as-4" });
    expect(recovered?.items).toHaveLength(4);
  });

  test("a turn the harness completed: blocks under their live ids, tool results, completed", async () => {
    const record = await readClaudeTurn(home, "5e55-1", 0);

    // The whole file is read from 0 here, so the second (cut) turn's tool call is in it too: only the first turn.
    const first = await readClaudeTurn(
      claudeHome("5e55-2", content.slice(0, content.indexOf('{"type":"last-prompt"'))),
      "5e55-2",
      0,
    );

    expect(first?.end).toMatchObject({ outcome: TurnOutcome.COMPLETED, providerTurnRef: "as-4" });
    expect(summary(first!.items)).toEqual([
      ["msg_A:0", "COMPLETED", "reasoning"],
      ["msg_A:1", "COMPLETED", "agentMessage"],
      ["toolu_1", "COMPLETED", "commandExecution"],
      ["msg_B:0", "COMPLETED", "agentMessage"],
    ]);
    expect(first!.items[2]!.content).toEqual({
      case: "commandExecution",
      value: { command: "sleep 2; echo slept-ok", output: "slept-ok" },
    });
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
    expect(limit?.end).toMatchObject({
      outcome: TurnOutcome.FAILED,
      source: TurnEndSource.HARNESS,
      errorCode: "usage_limit_reached",
      reason: expect.stringContaining("session limit"),
    });
    const stopped = await readClaudeTurn(claudeHome("e2", errors), "e2", byteOffset(errors, "Try a tool"));
    expect(stopped?.end).toMatchObject({ outcome: TurnOutcome.INTERRUPTED, source: TurnEndSource.USER });
    expect(summary(stopped!.items)).toEqual([["toolu_9", "FAILED", "commandExecution"]]);
    expect(await readClaudeTurn(home, "no-such-session", 0)).toBeUndefined();
  });
});

describe("reconcileEvents", () => {
  const item = (itemId: string, status: ItemStatus, text = itemId) =>
    create(ItemSchema, { itemId, status, content: { case: "agentMessage", value: { text } } });

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

    expect(
      events.map((e) => [
        e.body?.case,
        e.body?.case === "itemCompleted" ? e.body.value.item?.itemId : undefined,
        e.turnId,
      ]),
    ).toEqual([
      ["itemCompleted", "call_cell_1", "turn"],
      ["itemCompleted", "exec-cmd-1", "turn"],
      ["itemCompleted", "msg_final", "turn"],
      ["turnFinished", undefined, "turn"],
    ]);
    expect(events.at(-1)?.body).toMatchObject({
      case: "turnFinished",
      value: { outcome: TurnOutcome.COMPLETED, providerTurnRef: "turn-done" },
    });
    // Run again on the same journal state: the same events (the gateway deduplicates by item id; nothing new appears).
    expect(
      reconcileEvents(open([{ item: item("user-item-1", ItemStatus.COMPLETED), done: true }]), record, WORKER_RESTARTED)
        .length,
    ).toBe(5);
  });

  test("no end in the transcript: open items are interrupted and the turn ends with the cause", async () => {
    const record = await readCodexTurn(fixture("codex-rollout.jsonl"), 0, "turn-cut", "turn");

    const events = reconcileEvents(
      open([{ item: item("exec-live", ItemStatus.IN_PROGRESS), done: false }]),
      record,
      WORKER_RESTARTED,
    );

    const ended = events
      .filter((e) => e.body?.case === "itemCompleted")
      .map((e) => (e.body?.case === "itemCompleted" ? [e.body.value.item?.itemId, e.body.value.item?.status] : []));

    expect(ended).toContainEqual(["exec-live", ItemStatus.INTERRUPTED]);
    expect(events.at(-1)?.body).toMatchObject({
      case: "turnFinished",
      value: { outcome: TurnOutcome.INTERRUPTED, source: TurnEndSource.SYSTEM, reason: "worker restarted mid-turn" },
    });
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
      value: {
        outcome: TurnOutcome.INTERRUPTED,
        source: TurnEndSource.SYSTEM,
        reason: "worker restarted mid-turn (the harness stopped the turn: interrupted)",
      },
    });
  });

  test("no transcript at all: everything open ends, the turn ends with the cause", () => {
    const events = reconcileEvents(
      open([
        { item: item("a", ItemStatus.IN_PROGRESS), done: false },
        { item: item("b", ItemStatus.COMPLETED), done: true },
      ]),
      undefined,
      {
        outcome: TurnOutcome.FAILED,
        source: TurnEndSource.HARNESS,
        reason: "harness process exited (code 1)",
        errorCode: "process_exit",
      },
    );

    expect(events).toHaveLength(2);
    expect(events[0]?.body).toMatchObject({
      case: "itemCompleted",
      value: { item: { itemId: "a", status: ItemStatus.INTERRUPTED } },
    });
    expect(events[1]?.body).toMatchObject({
      case: "turnFinished",
      value: { outcome: TurnOutcome.FAILED, source: TurnEndSource.HARNESS, errorCode: "process_exit" },
    });
  });
});
