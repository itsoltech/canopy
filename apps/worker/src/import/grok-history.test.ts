import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, toJsonString } from "@bufbuild/protobuf";
import { ItemSchema, ReadImportPageSchema, type ImportedTurn } from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import { tempDirs } from "@canopy/testing";
import { installFixtureHome } from "./fixtures/install.ts";
import { readImportPage } from "./pages.ts";
import { WorkerImport } from "./service.ts";

/** Harness adapter test (docs/import.md, "Grok"): Grok sessions, with and without an ACP log, as Canopy turns. */

const temp = tempDirs();

function setup() {
  const root = temp("canopy-import-grok-");
  const home = join(root, "home");
  installFixtureHome(home, ["grok"]);

  const service = new WorkerImport({
    dataDir: join(root, "data"),
    homes: () => ({ claude: join(home, ".claude"), codex: join(home, ".codex"), grok: join(home, ".grok") }),
    config: () => undefined,
  });

  return { home, service };
}

async function read(service: WorkerImport, nativeId: string, maxBytes = 0, threadId = crypto.randomUUID()) {
  const summary = (await service.scan(["grok"])).threads.find((t) => t.nativeId === nativeId)!;
  const turns: ImportedTurn[] = [];
  const warnings: string[] = [];
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

    turns.push(...page.turns);
    warnings.push(...page.warnings);
    cursor = page.nextCursor;

    if (page.done) return { turns, warnings };
  }
}

const items = (turn: ImportedTurn) =>
  turn.events.flatMap((e) => (e.body.case === "itemCompleted" && e.body.value.item ? [e.body.value.item] : []));

test("the fixture session: prompts, a terminal command with its output, reasoning, stable ids across page splits", async () => {
  const { service } = setup();
  const id = (await service.scan(["grok"])).threads[0]!.nativeId;
  const threadId = crypto.randomUUID();
  const whole = await read(service, id, 0, threadId);
  const split = await read(service, id, 1, threadId);

  expect(whole.turns.map((t) => [t.prompt, t.status, t.model])).toEqual([
    ["Run the shell tool for FIXTURE_TOOL", "completed", "fixture-grok"],
    ["Think hard about FIXTURE_THINK", "completed", "fixture-grok"],
  ]);
  expect(split.turns.flatMap((t) => t.events.map((e) => e.eventId))).toEqual(
    whole.turns.flatMap((t) => t.events.map((e) => e.eventId)),
  );

  const tool = items(whole.turns[0]!).find(
    (i) => i.content.case === "commandExecution" || i.content.case === "toolCall",
  );

  expect(tool && toJsonString(ItemSchema, tool)).toContain("FIXTURE_TOOL_OUTPUT");
  expect(items(whole.turns[1]!).some((i) => i.content.case === "reasoning")).toBe(true);
});

const groupOf = (home: string) => join(home, ".grok", "sessions", encodeURIComponent(join(home, "project")));

const rec = (n: number, update: JsonObject, method = "session/update") =>
  `${JSON.stringify({ timestamp: 1_790_000_000 + n, method, params: { sessionId: "s", update } })}\n`;

test("an interactive session logs no prompts: turns end at turn_completed", async () => {
  const { service, home } = setup();
  const id = crypto.randomUUID();
  const dir = join(groupOf(home), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "updates.jsonl"),
    rec(1, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "First answer" } }) +
      rec(2, { sessionUpdate: "turn_completed", stop_reason: "end_turn" }, "_x.ai/session/update") +
      "{oops\n" +
      rec(3, {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "read_file",
        kind: "read",
        status: "pending",
        rawInput: { path: "a" },
      }) +
      rec(4, {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "file body" } }],
      }) +
      rec(5, { sessionUpdate: "turn_completed", stop_reason: "cancelled" }, "_x.ai/session/update"),
  );
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ chat_format_version: 1, generated_title: "Interactive" }));
  const { turns, warnings } = await read(service, id);

  expect(warnings).toEqual(["1 line could not be read"]);
  expect(turns.map((t) => [t.prompt, t.status])).toEqual([
    ["", "completed"],
    ["", "interrupted"],
  ]);
  expect(
    items(turns[1]!)
      .map((i) => toJsonString(ItemSchema, i))
      .join(),
  ).toContain("file body");
});

test("without an ACP log the chat history gives prompts, answers and tool calls with results", async () => {
  const { service, home } = setup();
  const id = crypto.randomUUID();
  const dir = join(groupOf(home), id);
  mkdirSync(dir, { recursive: true });
  const line = (entry: JsonObject) => `${JSON.stringify(entry)}\n`;
  writeFileSync(
    join(dir, "chat_history.jsonl"),
    line({ type: "system", content: "You are Grok" }) +
      line({ type: "user", content: [{ type: "text", text: "<user_info>x</user_info>" }] }) +
      line({
        type: "user",
        content: [{ type: "text", text: "<user_query>\nCount the files\n</user_query>" }],
        prompt_index: 0,
      }) +
      line({
        type: "assistant",
        content: "",
        tool_calls: [{ id: "c1", name: "list_dir", arguments: '{"path":"."}' }],
        model_id: "grok-4.7",
      }) +
      line({ type: "tool_result", tool_call_id: "c1", content: "a b c" }) +
      line({ type: "assistant", content: "Three files.", model_id: "grok-4.7" }),
  );
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ chat_format_version: 1 }));
  const { turns } = await read(service, id);

  expect(turns.map((t) => [t.prompt, t.model])).toEqual([["Count the files", "grok-4.7"]]);
  const content = items(turns[0]!).map((i) => i.content);
  expect(content.find((c) => c.case === "toolCall")?.value).toMatchObject({ name: "list_dir", output: "a b c" });
  expect(content.find((c) => c.case === "agentMessage")?.value).toMatchObject({ text: "Three files." });
});

test("a history file that links out of the Grok home reads nothing", async () => {
  const { service, home } = setup();
  const group = join(home, ".grok", "sessions", encodeURIComponent(join(home, "project")));
  const id = "01a1b2ac-0000-7000-8000-000000000042";
  mkdirSync(join(group, id), { recursive: true });
  const outside = join(home, "..", "outside-history.jsonl");
  writeFileSync(outside, `${JSON.stringify({ type: "user", prompt_index: 0, content: "OUTSIDE_CANARY" })}\n`);
  symlinkSync(outside, join(group, id, "chat_history.jsonl"));
  writeFileSync(join(group, id, "summary.json"), JSON.stringify({ generated_title: "linked" }));
  const scan = await service.scan(["grok"]);
  const summary = scan.threads.find((t) => t.nativeId === id);

  expect(`${summary?.title}${summary?.preview}`).not.toContain("OUTSIDE_CANARY");
  expect(summary?.format).toBe("empty");

  const page = readImportPage(
    service,
    create(ReadImportPageSchema, {
      sourceKey: summary!.sourceKey,
      snapshot: summary!.snapshot,
      threadId: crypto.randomUUID(),
    }),
  );

  expect(page.turns).toHaveLength(0);
});

test("an answer that grew after the import gets a new event when the last turn is read again", async () => {
  const { service, home } = setup();
  const group = join(home, ".grok", "sessions", encodeURIComponent(join(home, "project")));
  const id = "01a1b2ac-0000-7000-8000-000000000077";
  mkdirSync(join(group, id), { recursive: true });
  const update = (u: JsonObject, method = "session/update") => `${JSON.stringify({ method, params: { update: u } })}\n`;
  const path = join(group, id, "updates.jsonl");
  writeFileSync(
    path,
    update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Question" } }) +
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } }),
  );
  const threadId = crypto.randomUUID();

  const page = async (cursor: string) => {
    const summary = (await service.scan(["grok"])).threads.find((t) => t.nativeId === id)!;

    return readImportPage(
      service,
      create(ReadImportPageSchema, { sourceKey: summary.sourceKey, snapshot: summary.snapshot, cursor, threadId }),
    );
  };

  const first = await page("");
  appendFileSync(
    path,
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " world" } }) +
      update({ sessionUpdate: "turn_completed", stop_reason: "end_turn" }, "_x.ai/session/update"),
  );
  const again = await page(first.nextCursor);

  const answer = (p: typeof first) =>
    p.turns[0]!.events.find(
      (e) => e.body.case === "itemCompleted" && e.body.value.item?.content.case === "agentMessage",
    )!;

  expect(again.turns[0]!.turnId).toBe(first.turns[0]!.turnId);
  expect(answer(again).eventId).not.toBe(answer(first).eventId);
  const grown = items(again.turns[0]!).find((i) => i.content.case === "agentMessage");
  expect(grown?.content.case === "agentMessage" && grown.content.value.text).toBe("Hello world");
  expect(again.turns[0]!.status).toBe("completed");
});

test("a diff of JSON with an escaped secret is masked before it becomes a file change", async () => {
  const { service, home } = setup();
  const secret = 'gr\\ok"secret-CANARY-0042';
  writeFileSync(join(home, ".grok", "auth.json"), JSON.stringify({ token: secret }));
  const group = join(home, ".grok", "sessions", encodeURIComponent(join(home, "project")));
  const id = "01a1b2ac-0000-7000-8000-000000000099";
  mkdirSync(join(group, id), { recursive: true });
  const update = (u: JsonObject, method = "session/update") => `${JSON.stringify({ method, params: { update: u } })}\n`;
  const config = JSON.stringify({ token: secret }, null, 2);
  writeFileSync(
    join(group, id, "updates.jsonl"),
    update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Write the config" } }) +
      update({
        sessionUpdate: "tool_call",
        toolCallId: "w1",
        title: "Write config.json",
        kind: "edit",
        status: "completed",
        content: [{ type: "diff", path: "config.json", oldText: null, newText: config }],
        rawInput: { path: "config.json", content: config },
      }) +
      update({ sessionUpdate: "turn_completed", stop_reason: "end_turn" }, "_x.ai/session/update"),
  );
  const { turns } = await read(service, id);

  expect(JSON.stringify(turns.flatMap((t) => items(t).map((i) => toJsonString(ItemSchema, i))))).not.toContain(
    "CANARY",
  );
});
