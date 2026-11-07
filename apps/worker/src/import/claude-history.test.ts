import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, toBinary, toJson } from "@bufbuild/protobuf";
import {
  ImportedTurnSchema,
  ImportPageSchema,
  ItemSchema,
  ItemStatus,
  ReadImportPageSchema,
  ThreadEventSchema,
  type ImportPage,
} from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import { tempDirs } from "@canopy/testing";
import { installFixtureHome } from "./fixtures/install.ts";
import { readImportPage } from "./pages.ts";
import { WorkerImport } from "./service.ts";

/** Harness adapter test (docs/import.md, "Claude"): a Claude Code session file as Canopy turns. */

const temp = tempDirs();

function setup() {
  const root = temp("canopy-import-claude-");
  const home = join(root, "home");
  installFixtureHome(home, ["claude"]);

  const service = new WorkerImport({
    dataDir: join(root, "data"),
    homes: () => ({ claude: join(home, ".claude"), codex: join(home, ".codex"), grok: join(home, ".grok") }),
    config: () => undefined,
  });

  const dir = join(home, ".claude", "projects", "-synthetic");
  mkdirSync(dir, { recursive: true });

  return { home, service, dir };
}

async function pages(service: WorkerImport, nativeId: string, maxBytes = 0, threadId = crypto.randomUUID()) {
  const scan = await service.scan(["claude"]);
  const summary = scan.threads!.find((t) => t.nativeId === nativeId)!;
  const read: ImportPage[] = [];
  let cursor = "";

  for (;;) {
    const page = readImportPage(
      service,
      create(ReadImportPageSchema, {
        sourceKey: summary.sourceKey,
        snapshot: summary.snapshot,
        cursor,
        threadId,
        maxBytes,
      }),
    );

    read.push(page);
    cursor = page.nextCursor;

    if (page.done) return read;
  }
}

const line = (entry: JsonObject) =>
  `${JSON.stringify({ timestamp: "2026-10-01T10:00:00Z", version: "2.1.308", ...entry })}\n`;

const user = (uuid: string, parentUuid: string, content: JsonObject[string], extra: JsonObject = {}) =>
  line({ type: "user", uuid, parentUuid, message: { role: "user", content }, ...extra });

const assistant = (uuid: string, parentUuid: string, content: JsonObject[], extra: JsonObject = {}) =>
  line({
    type: "assistant",
    uuid,
    parentUuid,
    message: { id: `m-${uuid}`, role: "assistant", content, stop_reason: "end_turn" },
    ...extra,
  });

test("the fixture session: every turn, tool, reasoning, subagent and compaction, the same ids on every read", async () => {
  const { service, home } = setup();
  const scan = await service.scan(["claude"]);
  const id = scan.threads!.find((t) => t.cwd === join(home, "project"))!.nativeId!;
  const threadId = crypto.randomUUID();
  const whole = await pages(service, id, 0, threadId);
  const split = await pages(service, id, 1, threadId);

  expect(whole).toHaveLength(1);
  expect(split.length).toBe(5);
  const turns = whole.flatMap((p) => p.turns);
  expect(split.flatMap((p) => p.turns).map((t) => t.turnId)).toEqual(turns.map((t) => t.turnId));
  expect(split.flatMap((p) => p.turns.flatMap((t) => t.events.map((e) => e.eventId)))).toEqual(
    turns.flatMap((t) => t.events.map((e) => e.eventId)),
  );
  expect(turns.map((t) => t.prompt)).toEqual([
    "Run the shell tool for FIXTURE_TOOL",
    "Think hard about FIXTURE_THINK",
    "Use a subagent for FIXTURE_AGENT",
    "/compact",
    "Continue after compaction with FIXTURE_AFTER",
  ]);
  expect(turns.every((t) => t.providerTurnRef && t.startedAt && t.status === "completed")).toBe(true);
  // Another Canopy thread gets other ids: importing again after an undo never collides.
  const again = await pages(service, id, 0);
  expect(again[0]!.turns[0]!.turnId).not.toBe(turns[0]!.turnId);
});

test("follows the active branch, marks interruptions and API errors, and counts broken lines", async () => {
  const { service, dir } = setup();
  const id = crypto.randomUUID();

  const file =
    user("u1", "", "First prompt") +
    assistant("a1", "u1", [{ type: "text", text: "First answer" }]) +
    // An abandoned edit of the second prompt (a rewind), then the one the session kept.
    user("u2-old", "a1", "Abandoned prompt") +
    assistant("a2-old", "u2-old", [{ type: "text", text: "Abandoned answer" }]) +
    user("u2", "a1", "Kept prompt") +
    assistant("a2", "u2", [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "sleep 99" } }], {}) +
    user("u3", "a2", [{ type: "text", text: "[Request interrupted by user for tool use]" }]) +
    "{ broken\n" +
    user("u4", "u3", "Third prompt") +
    line({
      type: "assistant",
      uuid: "a4",
      parentUuid: "u4",
      isApiErrorMessage: true,
      error: "rate_limit",
      message: { id: "m-a4", role: "assistant", content: [{ type: "text", text: "API Error: rate limited" }] },
    }) +
    line({ type: "last-prompt", leafUuid: "u4" });

  writeFileSync(join(dir, `${id}.jsonl`), file.replace(/"timestamp"/g, `"sessionId":"${id}","timestamp"`));
  const [page] = await pages(service, id);

  expect(page!.warnings).toEqual(["1 earlier branch not imported", "1 line could not be read"]);
  expect(page!.turns.map((t) => [t.prompt, t.status])).toEqual([
    ["First prompt", "completed"],
    ["Kept prompt", "interrupted"],
    ["Third prompt", "failed"],
  ]);
  expect(page!.turns[2]!.error).toContain("rate limited");
  const tool = page!.turns[1]!.events.find((e) => e.body.case === "itemCompleted")!;
  expect(tool.body.case === "itemCompleted" && tool.body.value.item?.status).toBe(5);
  expect(JSON.stringify(page!.turns.map((t) => t.prompt))).not.toContain("Abandoned");
});

test("refuses a source whose start changed since the scan", async () => {
  const { service, dir } = setup();
  const id = crypto.randomUUID();
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, user("u1", "", "Hello").replace('"timestamp"', `"sessionId":"${id}","timestamp"`));
  const scan = await service.scan(["claude"]);
  const summary = scan.threads!.find((t) => t.nativeId === id)!;
  writeFileSync(path, user("u0", "", "Rewritten").replace('"timestamp"', `"sessionId":"${id}","timestamp"`));
  expect(() =>
    readImportPage(
      service,
      create(ReadImportPageSchema, {
        sourceKey: summary.sourceKey,
        snapshot: summary.snapshot,
        threadId: crypto.randomUUID(),
      }),
    ),
  ).toThrow("changed since the scan");
});

test("keeps parallel tool results that hang beside the chain", async () => {
  const { service, dir } = setup();
  const id = crypto.randomUUID();

  // Two tool calls of one message: each result points to its own call; the chain continues from the second.
  const file =
    user("u1", "", "Run two things") +
    assistant("a1", "u1", [{ type: "tool_use", id: "tool-a", name: "Bash", input: { command: "echo a" } }]) +
    assistant("a2", "a1", [{ type: "tool_use", id: "tool-b", name: "Bash", input: { command: "echo b" } }]) +
    user("ra", "a1", [{ type: "tool_result", tool_use_id: "tool-a", content: "a" }]) +
    user("rb", "a2", [{ type: "tool_result", tool_use_id: "tool-b", content: "b" }]) +
    assistant("a3", "rb", [{ type: "text", text: "Both done" }]);

  writeFileSync(join(dir, `${id}.jsonl`), file.replace(/"timestamp"/g, `"sessionId":"${id}","timestamp"`));
  const [page] = await pages(service, id);

  expect(page!.warnings).toEqual([]);

  const tools = page!.turns[0]!.events.flatMap((e) =>
    e.body.case === "itemCompleted" && e.body.value.item?.content.case === "commandExecution"
      ? [e.body.value.item]
      : [],
  );

  expect(tools.map((t) => [t.content.case === "commandExecution" && t.content.value.output, t.status])).toEqual([
    ["a", 2],
    ["b", 2],
  ]);
});

const items = (page: ImportPage) =>
  page.turns.flatMap((t) =>
    t.events.flatMap((e) => (e.body.case === "itemCompleted" && e.body.value.item ? [e.body.value.item] : [])),
  );

test("a line the CLI is still writing is read on the next import, and the last turn gets its finished steps", async () => {
  const { service, dir } = setup();
  const id = crypto.randomUUID();
  const path = join(dir, `${id}.jsonl`);
  const tool = { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } };
  const result = user("r1", "a1", [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }]);
  writeFileSync(path, user("u1", "", "List the files", { cwd: dir }) + assistant("a1", "u1", [tool]));
  // The CLI has written half of the tool result: it is not part of this import.
  appendFileSync(path, result.slice(0, 20));
  const threadId = crypto.randomUUID();
  const first = (await pages(service, id, 0, threadId)).at(-1)!;
  const size = Buffer.byteLength(user("u1", "", "List the files", { cwd: dir }) + assistant("a1", "u1", [tool]));

  expect(Number(first.bytesRead)).toBe(size);
  // The next import starts at the last turn, so its tool call can finish.
  expect(first.nextCursor).toBe("0");
  expect(items(first).find((i) => i.itemId === "t1")?.status).toBe(ItemStatus.INTERRUPTED);

  appendFileSync(path, result.slice(20));
  const summary = (await service.scan(["claude"])).threads!.find((t) => t.nativeId === id)!;

  const again = readImportPage(
    service,
    create(ReadImportPageSchema, {
      sourceKey: summary.sourceKey,
      snapshot: summary.snapshot,
      cursor: first.nextCursor,
      threadId,
    }),
  );

  const finished = items(again).find((i) => i.itemId === "t1")!;

  expect(finished.status).toBe(ItemStatus.COMPLETED);
  // Same turn, a new event for the step's new state (the gateway adds it to the stored turn).
  expect(again.turns[0]!.turnId).toBe(first.turns[0]!.turnId);

  const eventOf = (page: ImportPage) =>
    page.turns[0]!.events.find((e) => e.body.case === "itemCompleted" && e.body.value.item?.itemId === "t1")!.eventId;

  expect(eventOf(again)).not.toBe(eventOf(first));
});

test("entries that point to each other in a loop fail the source with a clear error instead of hanging", async () => {
  const { service, dir } = setup();
  const self = crypto.randomUUID();
  writeFileSync(
    join(dir, `${self}.jsonl`),
    user("u1", "", "hello", { cwd: dir }) + assistant("a1", "a1", [{ type: "text", text: "loop" }]),
  );
  await expect(pages(service, self)).rejects.toThrow("its own parent");

  // A loop beside the chain (two entries that are each other's parent) and a loop below the leaf.
  const side = crypto.randomUUID();
  writeFileSync(
    join(dir, `${side}.jsonl`),
    user("u1", "", "hello", { cwd: dir }) +
      assistant("a1", "u1", [{ type: "text", text: "hi" }]) +
      assistant("x1", "x2", [{ type: "text", text: "x" }]) +
      user("x2", "x1", "side prompt") +
      line({ type: "last-prompt", leafUuid: "u1" }),
  );
  const read = await pages(service, side);
  expect(read.flatMap((p) => p.turns.map((t) => t.prompt))).toEqual(["hello"]);

  const below = crypto.randomUUID();
  writeFileSync(
    join(dir, `${below}.jsonl`),
    user("u1", "", "hello", { cwd: dir }) +
      assistant("a1", "u1", [{ type: "text", text: "hi" }]) +
      assistant("a2", "a3", []) +
      assistant("a3", "a2", []) +
      line({ type: "last-prompt", leafUuid: "a2" }),
  );
  await expect(pages(service, below)).rejects.toThrow("loop");
}, 10_000);

test("an oversized tool input is cut with a note: a page stays far below the link's 32 MiB", async () => {
  const { service, dir } = setup();
  const id = crypto.randomUUID();
  const command = "x".repeat(33 * 1024 ** 2);

  const tools = Array.from({ length: 12 }, (_, n) => ({
    type: "tool_use",
    id: `t${n}`,
    name: "Bash",
    input: { command: `${n}${"y".repeat(1024 ** 2)}` },
  }));

  writeFileSync(
    join(dir, `${id}.jsonl`),
    user("u1", "", "big", { cwd: dir }) +
      assistant("a1", "u1", [{ type: "tool_use", id: "big", name: "Bash", input: { command } }]) +
      assistant("a2", "a1", tools),
  );
  const read = await pages(service, id);
  const sizes = read.map((p) => toBinary(ImportPageSchema, p).length);

  expect(Math.max(...sizes)).toBeLessThan(16 * 1024 ** 2);
  const big = items(read[0]!).find((i) => i.itemId === "big")!;
  expect(toBinary(ItemSchema, big).length).toBeLessThan(2.1 * 1024 ** 2);
  expect(JSON.stringify(toJson(ItemSchema, big))).toContain("shortened on import");
}, 60_000);

test("a secret with a backslash or quote is masked inside JSON tool arguments and results", async () => {
  const { service, dir, home } = setup();
  const secret = 'pa\\ss"word-CANARY-0042';
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ token: secret }));
  const id = crypto.randomUUID();
  writeFileSync(
    join(dir, `${id}.jsonl`),
    user("u1", "", `login with ${secret}`, { cwd: dir }) +
      assistant("a1", "u1", [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: `echo '${secret}'`, env: { nested: [secret] } } },
      ]) +
      user("r1", "a1", [{ type: "tool_result", tool_use_id: "t1", content: JSON.stringify({ out: secret }) }]),
  );
  const read = await pages(service, id);
  const sent = JSON.stringify(read.map((p) => toJson(ImportPageSchema, p)));

  expect(sent).not.toContain("CANARY");
  expect(sent).toContain("[redacted]");
});

test("a linked subagent sidecar outside the CLI home is not read", async () => {
  const { service, dir, home } = setup();
  const id = crypto.randomUUID();
  const outside = join(home, "..", "outside-subagents");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "agent-x.meta.json"), JSON.stringify({ toolUseId: "task1" }));
  writeFileSync(join(outside, "agent-x.jsonl"), assistant("s1", "", [{ type: "text", text: "OUTSIDE_CANARY" }]));
  mkdirSync(join(dir, id), { recursive: true });
  symlinkSync(outside, join(dir, id, "subagents"));
  writeFileSync(
    join(dir, `${id}.jsonl`),
    user("u1", "", "delegate", { cwd: dir }) +
      assistant("a1", "u1", [
        { type: "tool_use", id: "task1", name: "Task", input: { prompt: "go", description: "d" } },
      ]),
  );
  const sent = JSON.stringify((await pages(service, id)).map((p) => toJson(ImportPageSchema, p)));

  expect(sent).toContain("delegate");
  expect(sent).not.toContain("OUTSIDE_CANARY");
});

test("adversarial shapes stay within the encoded bounds: a step with 2,200 changes, a turn with 60,000 steps", async () => {
  const { finish, draft, setItem, MAX_EVENT, MAX_TURN } = await import("./turns.ts");
  const { Masker } = await import("./masking.ts");
  const turn = draft("t", "prompt", 0);

  const changes = Array.from({ length: 2200 }, (_, n) => ({
    path: `file-${n}.ts`,
    kind: "update",
    diff: "d".repeat(16 * 1024),
  }));

  setItem(turn, "wide", { case: "fileChange", value: { changes } }, ItemStatus.COMPLETED, 1);
  const finished = finish(crypto.randomUUID(), "s", turn, new Masker([]));
  const wide = finished.events.find((e) => e.body.case === "itemCompleted")!;

  expect(toBinary(ThreadEventSchema, wide).length).toBeLessThanOrEqual(MAX_EVENT);
  expect(toBinary(ImportedTurnSchema, finished).length).toBeLessThanOrEqual(MAX_TURN);

  // Many small steps in one turn of a real session file: the turn stops at its bound with a note.
  const { service, dir } = setup();
  const id = crypto.randomUUID();

  const tools = Array.from({ length: 60_000 }, (_, n) => ({
    type: "tool_use",
    id: `t${n}`,
    name: "Bash",
    input: { command: `echo ${n} ${"z".repeat(100)}` },
  }));

  writeFileSync(join(dir, `${id}.jsonl`), user("u1", "", "many", { cwd: dir }) + assistant("a1", "u1", tools));
  const read = await pages(service, id);

  for (const page of read) expect(toBinary(ImportPageSchema, page).length).toBeLessThan(16 * 1024 ** 2);
  const turnSize = Math.max(...read.flatMap((p) => p.turns.map((t) => toBinary(ImportedTurnSchema, t).length)));
  expect(turnSize).toBeLessThanOrEqual(MAX_TURN);
  expect(JSON.stringify(read.map((p) => toJson(ImportPageSchema, p)))).toContain("of this turn not imported");
}, 120_000);

test("a secret inside a JSON-encoded string nested in JSON is masked, at any depth", async () => {
  const { service, dir, home } = setup();
  const secret = 'ne\\st"ed-CANARY-0042';
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ token: secret }));
  const id = crypto.randomUUID();
  const nested = JSON.stringify(JSON.stringify(JSON.stringify({ token: secret })));
  writeFileSync(
    join(dir, `${id}.jsonl`),
    user("u1", "", "nested", { cwd: dir }) +
      assistant("a1", "u1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "x", payload: nested } }]) +
      user("r1", "a1", [{ type: "tool_result", tool_use_id: "t1", content: nested }]),
  );
  const sent = JSON.stringify((await pages(service, id)).map((p) => toJson(ImportPageSchema, p)));

  expect(sent).not.toContain("CANARY");
  expect(sent).toContain("[redacted]");
});

test("a long JSON result is masked whole before it is cut: an escaped secret near its start does not survive", async () => {
  const { service, dir, home } = setup();
  const secret = 'lo\\ng"secret-CANARY-0042';
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ token: secret }));
  const id = crypto.randomUUID();
  const result = JSON.stringify({ token: secret, padding: "p".repeat(2 * 1024 ** 2) });
  writeFileSync(
    join(dir, `${id}.jsonl`),
    user("u1", "", "long", { cwd: dir }) +
      assistant("a1", "u1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "x" } }]) +
      user("r1", "a1", [{ type: "tool_result", tool_use_id: "t1", content: result }]),
  );
  const sent = JSON.stringify((await pages(service, id)).map((p) => toJson(ImportPageSchema, p)));

  expect(sent).not.toContain("CANARY");
  expect(sent).toContain("shortened on import");
}, 30_000);

test("turn metadata is bounded too: a 5 MiB model name keeps the turn and the page within their budgets", async () => {
  const { finish, draft, MAX_TURN } = await import("./turns.ts");
  const { Masker } = await import("./masking.ts");
  const turn = draft("t", "prompt", 0);
  turn.model = "m".repeat(5 * 1024 ** 2);
  turn.providerTurnRef = "r".repeat(5 * 1024 ** 2);
  const finished = finish(crypto.randomUUID(), "s", turn, new Masker([]));

  expect(toBinary(ImportedTurnSchema, finished).length).toBeLessThan(64 * 1024);
  expect(finished.model.length).toBeLessThan(2048);
  expect(toBinary(ImportedTurnSchema, finished).length).toBeLessThanOrEqual(MAX_TURN);
});

test("tool inputs are masked as decoded values before any transform: a Write of JSON with an escaped secret", async () => {
  const { service, dir, home } = setup();
  const secret = 'wr\\ite"secret-CANARY-0042';
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ token: secret }));
  const id = crypto.randomUUID();
  const content = JSON.stringify({ deploy: { token: secret } }, null, 2);
  writeFileSync(
    join(dir, `${id}.jsonl`),
    user("u1", "", "write config", { cwd: dir }) +
      assistant("a1", "u1", [
        { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/tmp/x.json", content } },
      ]) +
      assistant("a2", "a1", [
        {
          type: "tool_use",
          id: "t2",
          name: "Edit",
          input: { file_path: "/tmp/x.json", old_string: content, new_string: "{}" },
        },
      ]),
  );
  const sent = JSON.stringify((await pages(service, id)).map((p) => toJson(ImportPageSchema, p)));

  expect(sent).not.toContain("CANARY");
  expect(sent).toContain("[redacted]");
});

test("a turn's note about left-out steps has a bounded id, whatever the source's turn id", async () => {
  const { finish, draft, setItem, MAX_TURN } = await import("./turns.ts");
  const { Masker } = await import("./masking.ts");
  const turn = draft("r".repeat(9 * 1024 ** 2), "prompt", 0);

  for (let n = 0; n < 60_000; n++)
    setItem(
      turn,
      `t${n}`,
      { case: "agentMessage", value: { text: `step ${n} ${"z".repeat(100)}` } },
      ItemStatus.COMPLETED,
      n,
    );
  const finished = finish(crypto.randomUUID(), "s", turn, new Masker([]));

  expect(toBinary(ImportedTurnSchema, finished).length).toBeLessThanOrEqual(MAX_TURN);
  expect(JSON.stringify(toJson(ImportedTurnSchema, finished))).toContain("of this turn not imported");
}, 60_000);
