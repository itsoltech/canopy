import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, toJson } from "@bufbuild/protobuf";
import { ImportedTurnSchema, ReadImportPageSchema, type ImportedTurn } from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import { tempDirs } from "@canopy/testing";
import { installFixtureHome } from "./fixtures/install.ts";
import { readImportPage } from "./pages.ts";
import { WorkerImport } from "./service.ts";

/** Harness adapter test (docs/import.md, "Codex"): Codex rollouts, newer and older formats, as Canopy turns. */

const temp = tempDirs();

function setup() {
  const root = temp("canopy-import-codex-");
  const home = join(root, "home");
  installFixtureHome(home, ["codex"]);

  const service = new WorkerImport({
    dataDir: join(root, "data"),
    homes: () => ({ claude: join(home, ".claude"), codex: join(home, ".codex"), grok: join(home, ".grok") }),
    config: () => undefined,
  });

  return { home, service };
}

async function read(service: WorkerImport, nativeId: string, maxBytes = 0, threadId = crypto.randomUUID()) {
  const summary = (await service.scan(["codex"])).threads.find((t) => t.nativeId === nativeId)!;
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

test("the fixture rollout: prompts, a command with its output, reasoning, and stable ids across page splits", async () => {
  const { service, home } = setup();
  const id = (await service.scan(["codex"])).threads.find((t) => t.cwd === join(home, "project"))!.nativeId;
  const threadId = crypto.randomUUID();
  const whole = await read(service, id, 0, threadId);
  const split = await read(service, id, 1, threadId);

  expect(whole.turns.map((t) => [t.prompt, t.status, t.model])).toEqual([
    ["Run the shell tool for FIXTURE_TOOL", "completed", "fixture-model"],
    ["Think hard about FIXTURE_THINK", "completed", "fixture-model"],
  ]);
  expect(split.turns.flatMap((t) => t.events.map((e) => e.eventId))).toEqual(
    whole.turns.flatMap((t) => t.events.map((e) => e.eventId)),
  );
  expect(whole.turns.every((t) => t.providerTurnRef)).toBe(true);
  const command = items(whole.turns[0]!).find((i) => i.content.case === "commandExecution");
  expect(command?.content.case === "commandExecution" && command.content.value.output).toContain("FIXTURE_TOOL_OUTPUT");
});

test("an older rollout without item_completed: messages, reasoning, shell calls, compaction, aborts and errors", async () => {
  const { service, home } = setup();
  const id = crypto.randomUUID();
  const dir = join(home, ".codex", "sessions", "2025", "06", "01");
  mkdirSync(dir, { recursive: true });
  const at = (n: number) => new Date(Date.UTC(2025, 5, 1, 10, n)).toISOString();

  const rec = (n: number, type: string, payload: JsonObject) =>
    `${JSON.stringify({ timestamp: at(n), type, payload })}\n`;

  writeFileSync(
    join(dir, `rollout-2025-06-01T10-00-00-${id}.jsonl`),
    rec(0, "session_meta", { id, cwd: join(home, "project"), cli_version: "0.30.0", originator: "codex_cli_rs" }) +
      rec(1, "response_item", {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }],
      }) +
      rec(1, "event_msg", { type: "user_message", message: "List the files" }) +
      rec(2, "response_item", {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Thinking about files" }],
      }) +
      rec(2, "response_item", {
        type: "function_call",
        name: "shell",
        call_id: "c1",
        arguments: JSON.stringify({ command: ["ls"] }),
      }) +
      rec(3, "response_item", {
        type: "function_call_output",
        call_id: "c1",
        output: JSON.stringify({ output: "a.txt\nb.txt", metadata: { exit_code: 0 } }),
      }) +
      rec(4, "response_item", {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Two files." }],
      }) +
      "not json\n" +
      rec(5, "event_msg", { type: "user_message", message: "Summarize everything" }) +
      rec(6, "compacted", { message: "Summary of the earlier work" }) +
      rec(7, "event_msg", { type: "turn_aborted", reason: "interrupted" }) +
      rec(8, "event_msg", { type: "task_started", turn_id: "t3" }) +
      rec(8, "event_msg", { type: "user_message", message: "Try again" }) +
      rec(9, "event_msg", { type: "task_complete", turn_id: "t3", error: { message: "unexpected status 401" } }),
  );
  const { turns, warnings } = await read(service, id);

  expect(warnings).toEqual(["1 line could not be read"]);
  expect(turns.map((t) => [t.prompt, t.status])).toEqual([
    ["List the files", "completed"],
    ["Summarize everything", "interrupted"],
    ["Try again", "failed"],
  ]);
  const first = items(turns[0]!).map((i) => i.content);
  expect(first.find((c) => c.case === "reasoning")?.value).toMatchObject({ text: "Thinking about files" });
  expect(first.find((c) => c.case === "agentMessage")?.value).toMatchObject({ text: "Two files." });
  expect(first.some((c) => c.case === "commandExecution")).toBe(true);
  expect(items(turns[1]!).map((i) => i.content.case)).toContain("contextCompaction");
  expect(turns[2]!.error).toContain("401");
});

test("a record Codex is still writing waits for the next import, which reads the last turn again", async () => {
  const { service, home } = setup();
  const id = crypto.randomUUID();
  const dir = join(home, ".codex", "sessions", "2025", "06", "02");
  mkdirSync(dir, { recursive: true });
  const at = new Date(Date.UTC(2025, 5, 2, 10)).toISOString();
  const rec = (type: string, payload: JsonObject) => `${JSON.stringify({ timestamp: at, type, payload })}\n`;

  const complete =
    rec("session_meta", { id, cwd: join(home, "project"), cli_version: "0.30.0" }) +
    rec("event_msg", { type: "user_message", message: "First" }) +
    rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "One." }] });

  const partial = rec("event_msg", { type: "user_message", message: "Second" });
  writeFileSync(join(dir, `rollout-2025-06-02T10-00-00-${id}.jsonl`), complete + partial.slice(0, 15));
  const summary = (await service.scan(["codex"])).threads.find((t) => t.nativeId === id)!;

  const page = readImportPage(
    service,
    create(ReadImportPageSchema, {
      sourceKey: summary.sourceKey,
      snapshot: summary.snapshot,
      threadId: crypto.randomUUID(),
    }),
  );

  expect(Number(page.bytesRead)).toBe(Buffer.byteLength(complete));
  expect(Number(page.nextCursor)).toBe(complete.indexOf(rec("event_msg", { type: "user_message", message: "First" })));
  expect(page.turns.map((t) => t.prompt)).toEqual(["First"]);
});

test("a patch or command with an escaped secret in JSON is masked before it becomes a file change or preview", async () => {
  const { service, home } = setup();
  const secret = 'pa\\tch"secret-CANARY-0042';
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ token: secret }));
  const id = crypto.randomUUID();
  const dir = join(home, ".codex", "sessions", "2025", "06", "03");
  mkdirSync(dir, { recursive: true });
  const at = new Date(Date.UTC(2025, 5, 3, 10)).toISOString();
  const rec = (type: string, payload: JsonObject) => `${JSON.stringify({ timestamp: at, type, payload })}\n`;
  const config = JSON.stringify({ token: secret }, null, 2);
  writeFileSync(
    join(dir, `rollout-2025-06-03T10-00-00-${id}.jsonl`),
    rec("session_meta", { id, cwd: join(home, "project"), cli_version: "0.30.0" }) +
      rec("event_msg", { type: "user_message", message: "Write the config" }) +
      rec("response_item", {
        type: "function_call",
        name: "shell",
        call_id: "c1",
        arguments: JSON.stringify({ command: ["sh", "-c", `printf '%s' '${config}' > config.json`] }),
      }) +
      rec("response_item", {
        type: "function_call_output",
        call_id: "c1",
        output: JSON.stringify({ output: config }),
      }) +
      rec("response_item", {
        type: "custom_tool_call",
        name: "apply_patch",
        call_id: "c2",
        input: `*** Begin Patch\n*** Add File: config.json\n+${config.split("\n").join("\n+")}\n*** End Patch`,
      }),
  );
  const { turns } = await read(service, id);
  const sent = JSON.stringify(turns.map((t) => toJson(ImportedTurnSchema, t)));

  expect(sent).not.toContain("CANARY");
});
