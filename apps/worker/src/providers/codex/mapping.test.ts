import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import type { ServerNotification } from "@canopy/codex-protocol";
import {
  ItemStatus,
  NoticeLevel,
  ThreadEventSchema,
  ThreadStatus,
  TurnOrigin,
  TurnOutcome,
  type Item,
  type ThreadEvent,
} from "@canopy/contracts";
import { eventItemId, reduceItem } from "@canopy/domain";
import { CodexEventMapper, mapItem } from "./mapping.ts";

/** Recorded live streams (Codex 0.164.0), scrubbed of local paths and moderation metadata. */
function fixture(name: string): ServerNotification[] {
  return readFileSync(join(import.meta.dir, "fixtures", `${name}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ServerNotification);
}

function replay(notifications: ServerNotification[], commandTurns: ReadonlySet<string> = new Set(), before?: (mapper: CodexEventMapper, n: ServerNotification) => void) {
  const turnIds = new Map<string, string>();
  const mapper: CodexEventMapper = new CodexEventMapper({
    startTurn: (codexTurnId) => turnIds.get(codexTurnId) ?? turnIds.set(codexTurnId, `turn-${turnIds.size + 1}`).get(codexTurnId)!,
    turnId: (codexTurnId) => turnIds.get(codexTurnId),
    isCommandTurn: (codexTurnId) => commandTurns.has(codexTurnId),
  });
  const events: ThreadEvent[] = [];
  for (const n of notifications) {
    before?.(mapper, n);
    for (const init of mapper.map(n)) events.push(create(ThreadEventSchema, { threadId: "t", ...init } as never));
  }
  // Same projection the gateway and the UI run.
  const items = new Map<string, Item>();
  for (const e of events) {
    const id = eventItemId(e.body);
    if (!id) continue;
    const next = reduceItem(items.get(id), e.body);
    if (next) items.set(id, next);
  }
  return { events, items: [...items.values()], mapper };
}

const background = (item: Item | undefined) => (item?.content.case === "backgroundTask" ? item.content.value : undefined);

describe("Codex event mapping on a recorded turn with tools", () => {
  const notifications = fixture("tools-turn");
  const codexTurnId = (notifications.find((n) => n.method === "turn/started")!.params as { turn: { id: string } }).turn.id;
  const { events, items } = replay(notifications, new Set([codexTurnId]));

  test("nothing is lost: every notification yields an event with the raw original", () => {
    expect(events).toHaveLength(notifications.length);
    expect(events.every((e) => e.rawJson.length > 0)).toBe(true);
    // Unmapped notifications (moderation metadata, read state) are kept without a body.
    const unmapped = events.filter((e) => e.body.case === undefined).map((e) => JSON.parse(e.rawJson).method);
    expect(new Set(unmapped)).toEqual(new Set(["turn/moderationMetadata", "thread/readState/changed"]));
  });

  test("turn lifecycle: started by the platform, finished with outcome and usage", () => {
    const started = events.find((e) => e.body.case === "turnStarted");
    expect(started?.turnId).toBe("turn-1");
    expect(started?.body.case === "turnStarted" && started.body.value).toMatchObject({ providerTurnRef: codexTurnId, origin: TurnOrigin.COMMAND });
    const finished = events.find((e) => e.body.case === "turnFinished");
    expect(finished?.body.case === "turnFinished" && finished.body.value.outcome).toBe(TurnOutcome.COMPLETED);
    expect(finished?.body.case === "turnFinished" && finished.body.value.usage?.inputTokens).toBe(24055n);
  });

  test("thread activity: running, then idle", () => {
    const statuses = events.flatMap((e) => (e.body.case === "activity" ? [e.body.value.status] : []));
    expect(statuses).toEqual([ThreadStatus.RUNNING, ThreadStatus.IDLE]);
  });

  test("projected items: user message, commentary, two commands with output, final answer", () => {
    const summary = items.map((item) => {
      switch (item.content.case) {
        case "userMessage":
          return ["user", item.content.value.text.slice(0, 20)];
        case "agentMessage":
          return ["agent", item.content.value.phase, item.content.value.text];
        case "commandExecution":
          return ["command", item.content.value.command, item.content.value.exitCode, item.content.value.output];
        default:
          return [item.content.case];
      }
    });
    expect(summary).toEqual([
      ["user", "Create a file named "],
      ["agent", "commentary", "I’ll create `hello.txt` with exactly `hi`, then run `cat hello.txt`."],
      ["command", "/usr/bin/bash -lc 'printf hi > hello.txt'", 0, ""],
      ["command", "/usr/bin/bash -lc 'cat hello.txt'", 0, "hi"],
      ["agent", "final_answer", "DONE"],
    ]);
    expect(items.every((item) => item.status === ItemStatus.COMPLETED)).toBe(true);
  });

  test("streamed deltas assemble the same text as the completed item", () => {
    const commentary = notifications.filter((n) => n.method === "item/agentMessage/delta").slice(0, -1);
    const text = commentary.map((n) => (n.params as { delta: string }).delta).join("");
    expect(text).toBe("I’ll create `hello.txt` with exactly `hi`, then run `cat hello.txt`.");
  });
});

describe("Codex event mapping on a recorded failing turn", () => {
  const { events } = replay(fixture("error-turn"));

  test("provider-started turn (not from StartTurn), failure reason, error notice, failed activity", () => {
    const started = events.find((e) => e.body.case === "turnStarted");
    expect(started?.body.case === "turnStarted" && started.body.value.origin).toBe(TurnOrigin.PROVIDER);
    const finished = events.find((e) => e.body.case === "turnFinished");
    expect(finished?.body.case === "turnFinished" && finished.body.value).toMatchObject({
      outcome: TurnOutcome.FAILED,
      reason: "Missing environment variable: `CLIPROXY_API_KEY`.",
    });
    const notice = events.find((e) => e.body.case === "notice");
    expect(notice?.body.case === "notice" && notice.body.value).toMatchObject({ level: NoticeLevel.ERROR, code: "other" });
    expect(events.flatMap((e) => (e.body.case === "activity" ? [e.body.value.status] : []))).toEqual([
      ThreadStatus.RUNNING,
      ThreadStatus.FAILED,
    ]);
    // Hooks from the device's ~/.codex appear raw (this recording ran without CODEX_HOME isolation).
    expect(events.some((e) => e.body.case === undefined && JSON.parse(e.rawJson).method === "hook/started")).toBe(true);
  });
});

describe("Codex background processes (recorded: unified exec outliving its turn)", () => {
  test("the process gets a background item at turn end; later output and the exit land on it, outside the turn", () => {
    const { events, items, mapper } = replay(fixture("background-process-turn"));
    const finishedAt = events.findIndex((e) => e.body.case === "turnFinished");
    const startedBg = events.findIndex((e) => e.body.case === "itemStarted" && e.body.value.item?.content.case === "backgroundTask");
    expect(startedBg).toBe(finishedAt - 1);
    const command = items.find((i) => i.content.case === "commandExecution")!;
    const task = items.find((i) => i.itemId === `bg:${command.itemId}`);
    expect(background(task)).toMatchObject({ kind: 4, startedInTurnId: "turn-1", sourceItemId: command.itemId, processId: "3504", taskId: "3504" });
    expect(task?.status).toBe(ItemStatus.COMPLETED);
    // Everything Codex streamed, once: before the turn ended (carried over) and after it. The first line came
    // with the exec call's own result (for the model), not as a delta.
    expect(background(task)?.output).toBe(Array.from({ length: 39 }, (_, i) => `tick ${i + 2}\n`).join(""));
    // The command item keeps what its turn showed and ends with the process.
    expect(command.status).toBe(ItemStatus.COMPLETED);
    expect(command.content.case === "commandExecution" && command.content.value.output).toBe("tick 2\ntick 3\ntick 4\n");
    // After the turn nothing is linked to it: no event can recreate a finished turn.
    expect(events.slice(finishedAt + 1).every((e) => e.turnId === "")).toBe(true);
    expect(mapper.backgroundTasks).toEqual([]);
  });

  test("a stop requested by the platform ends the item as interrupted (stopped by the user)", () => {
    const { items, mapper } = replay(fixture("background-process-stopped"), new Set(), (m, n) => {
      if (n.method === "item/completed" && (n.params as { item: { type: string } }).item.type === "commandExecution") m.markStopping("40172");
    });
    const task = items.find((i) => i.content.case === "backgroundTask");
    expect(task?.status).toBe(ItemStatus.INTERRUPTED);
    expect(background(task)?.stopReason).toBe("stopped_by_user");
    expect(background(task)?.output).toContain("tick 20");
    expect(mapper.backgroundTasks).toEqual([]);
  });

  test("events of unknown Codex turns do not claim a pending StartTurn", () => {
    const pending = ["platform-turn"];
    const mapper = new CodexEventMapper({
      startTurn: () => pending.shift() ?? "provider-turn",
      turnId: () => undefined,
      isCommandTurn: () => true,
    });
    const [delta] = mapper.map({ method: "item/commandExecution/outputDelta", params: { threadId: "x", turnId: "old", itemId: "e1", delta: "late\n" } } as ServerNotification);
    expect(delta?.turnId).toBeUndefined();
    expect(pending).toEqual(["platform-turn"]);
  });
});

describe("Codex goals (recorded)", () => {
  const states = (name: string) =>
    replay(fixture(name)).events.flatMap((e) => (e.body.case === "goalState" ? [{ turnId: e.turnId, ...e.body.value }] : []));

  test("set active -> Codex starts a provider turn and completes the goal", () => {
    const { events } = replay(fixture("goal-complete"));
    const started = events.find((e) => e.body.case === "turnStarted");
    expect(started?.body.case === "turnStarted" && started.body.value.origin).toBe(TurnOrigin.PROVIDER);
    const goal = states("goal-complete");
    expect(goal.map((g) => g.nativeStatus)).toEqual(["active", "active", "active", "complete"]);
    expect(goal[0]).toMatchObject({ turnId: "", tokenBudget: 60000n, objective: expect.stringContaining("goal.txt") });
    expect(goal.at(-1)).toMatchObject({ turnId: "turn-1", tokensUsed: 13267n });
  });

  test("pause, resume and clear", () => {
    const goal = states("goal-pause-resume-clear");
    expect(goal.map((g) => (g.cleared ? "cleared" : g.nativeStatus))).toEqual(["active", "active", "paused", "active", "active", "complete", "cleared"]);
  });
});

/** Summary of command and tool call items: what the transcript shows for each command. */
function commandSummary(items: readonly Item[]) {
  return items.flatMap((item) =>
    item.content.case === "commandExecution"
      ? [["command", item.itemId, item.content.value.command, item.content.value.exitCode, item.status]]
      : item.content.case === "toolCall"
        ? [["tool", item.itemId, item.content.value.name, item.status]]
        : [],
  );
}

// Live recording (threads.live.test.ts): ping without network, ls and git status in one code-mode cell.
// rawResponseItem/completed come from the rollout (threads.ts); Codex reports no item for the failing ping.
describe("Codex event mapping on a recorded code-mode turn", () => {
  const notifications = fixture("code-mode-commands");
  const { events, items } = replay(notifications);
  const cell = items.find((item) => item.content.case === "toolCall");

  test("the code-mode cell is a tool call with its script and full result, the failing command included", () => {
    expect(cell?.content.case === "toolCall" && cell.content.value.name).toBe("exec");
    expect(cell?.status).toBe(ItemStatus.COMPLETED);
    const value = cell?.content.case === "toolCall" ? cell.content.value : undefined;
    expect(JSON.parse(value?.inputJson ?? "{}").code).toContain("ping -c 4 8.8.8.8");
    expect(value?.output).toContain('{"command":"ping -c 4 8.8.8.8"');
    expect(value?.output).toContain('"exit_code":2');
    expect(value?.output).toContain("ping: socket: Operation not permitted");
  });

  test("the cell starts before its nested commands, which Codex reports as command items", () => {
    expect(commandSummary(items).map(([kind, , name]) => [kind, name])).toEqual([
      ["tool", "exec"],
      ["command", "/usr/bin/bash -lc 'git status'"],
      ["command", "/usr/bin/bash -lc 'ls -lah'"],
    ]);
  });

  test("other model output items from the rollout yield nothing: app-server items already cover them", () => {
    const raw = notifications.filter((n) => n.method === "rawResponseItem/completed");
    const fromRaw = events.filter((e) => JSON.parse(e.rawJson).method === "rawResponseItem/completed");
    expect(fromRaw.map((e) => e.body.case)).toEqual(["itemStarted", "itemCompleted"]);
    expect(events).toHaveLength(notifications.length - raw.length + fromRaw.length);
  });
});

// Live recording with direct tools (exec_command per command; model catalog without code mode, raw events on).
describe("Codex event mapping on a recorded turn with direct shell calls", () => {
  const notifications = fixture("direct-shell-turn");
  const { events, items } = replay(notifications);

  test("a shell call without a Codex item becomes a command item at the turn end, with output and exit code", () => {
    const commands = items.filter((item) => item.content.case === "commandExecution");
    expect(commands.map((item) => (item.content.case === "commandExecution" ? [item.content.value.command, item.content.value.exitCode, item.status] : []))).toEqual([
      ["/usr/bin/bash -lc ls", 0, ItemStatus.COMPLETED],
      ["ping -c 1 8.8.8.8", 2, ItemStatus.FAILED],
      ['echo "Operation not permitted" >&2; exit 1', 1, ItemStatus.FAILED],
    ]);
    const ping = commands[1]?.content;
    expect(ping?.case === "commandExecution" && ping.value.output).toBe("ping: socktype: SOCK_DGRAM\nping: socket: Operation not permitted\n");
    // Ids are the call ids, the same as Codex's own command items would have.
    const calls = notifications.flatMap((n) => {
      const item = n.method === "rawResponseItem/completed" ? n.params.item : undefined;
      return item?.type === "function_call" ? [item.call_id] : [];
    });
    expect(commands.map((item) => item.itemId).sort()).toEqual([...calls].sort());
    // Emitted right before turn_finished, in the same turn.
    const cases = events.map((e) => e.body.case);
    expect(cases.slice(-3)).toEqual(["itemCompleted", "itemCompleted", "turnFinished"]);
  });
});

describe("mapItem", () => {
  test("file changes, MCP and agent bus calls, unknown types", () => {
    expect(
      mapItem(
        {
          type: "fileChange",
          id: "f1",
          status: "completed",
          changes: [
            { path: "a.ts", kind: { type: "add" }, diff: "+x" },
            { path: "b.ts", kind: { type: "update", move_path: "c.ts" }, diff: "" },
          ],
        },
        true,
      ),
    ).toMatchObject({
      status: ItemStatus.COMPLETED,
      content: { case: "fileChange", value: { changes: [{ path: "a.ts", kind: "add" }, { path: "b.ts", kind: "move", movePath: "c.ts" }] } },
    });

    const bus = mapItem(
      {
        type: "dynamicToolCall",
        id: "call-1",
        namespace: null,
        tool: "spawn_thread",
        arguments: { title: "Review", prompt: "Review" },
        status: "completed",
        contentItems: [{ type: "inputText", text: '{"thread_id":"x"}' }],
        success: true,
        durationMs: 12,
      },
      true,
    );
    expect(bus.content?.case).toBe("agentBusCall");

    const declined = mapItem(
      {
        type: "commandExecution",
        id: "c1",
        pluginId: null,
        scriptPath: null,
        command: "rm -rf /",
        cwd: "/work/repo",
        processId: null,
        source: "agent",
        status: "declined",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      },
      true,
    );
    expect(declined.status).toBe(ItemStatus.DECLINED);

    const unknown = mapItem({ type: "sleep", id: "s1", durationMs: 1000 }, true);
    expect(unknown.content).toMatchObject({ case: "providerItem", value: { type: "sleep" } });
  });

  test("a steered message keeps the platform's id (turn/steer clientUserMessageId)", () => {
    const steered = mapItem({ type: "userMessage", id: "u1", clientId: "steer-1", content: [{ type: "text", text: "also X", text_elements: [] }] }, true);
    expect(steered.content).toEqual({ case: "userMessage", value: { text: "also X", clientId: "steer-1" } });
  });
});
