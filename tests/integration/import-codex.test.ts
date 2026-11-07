import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { probeRecords } from "./fixtures/instance-probe.ts";
import { treeFingerprint } from "../../apps/worker/src/import/fixtures/install.ts";
import { eventually } from "./support/gateway.ts";
import { importFixture } from "./support/imports.ts";

/** CLI import, stage 4 (docs/import.md, "Codex"): Codex rollouts into threads that continue in Canopy. */
describe.skipIf(!dockerAvailable)("CLI import: Codex", () => {
  const dir = tempDir("canopy-import-codex-");
  let f: Awaited<ReturnType<typeof importFixture>>;

  const finished = (runId: string) =>
    eventually(
      () => f.gw.api.getImportRun({ runId, items: true }),
      (r) => !["running", "paused"].includes(r.status),
      20_000,
    );

  const importAll = async (mode: string) => {
    const { scanId } = await f.gw.api.scanImport({ workerId: f.workerId });
    const run = await f.gw.api.startImport({ scanId, selection: { allMatching: true, filter: {} }, mode });

    return finished(run.id);
  };

  beforeAll(async () => {
    f = await importFixture(dir, { clis: ["codex"], codex: true });
  }, 120_000);

  afterEach(async () => {
    await f?.restore();
  });

  afterAll(async () => {
    delete process.env["INSTANCE_TRACE"];
    await f?.close();
  });

  test("imports turns, commands with their output and reasoning, and leaves the rollouts untouched", async () => {
    const before = treeFingerprint(join(f.home, ".codex"));
    const done = await importAll("history");
    expect(done).toMatchObject({ status: "completed", done: 2, failed: 0 });
    expect(treeFingerprint(join(f.home, ".codex"))).toBe(before);
    const main = done.items.find((i) => i.cwd.endsWith("project"))!;
    const { thread, turns, items } = await f.snapshot(main.threadId);
    expect(thread?.import).toMatchObject({ agentCli: "codex", mode: "history" });
    expect(turns.map((t) => [t.inputText, t.status, t.model])).toEqual([
      ["Run the shell tool for FIXTURE_TOOL", "completed", "fixture-model"],
      ["Think hard about FIXTURE_THINK", "completed", "fixture-model"],
    ]);
    const content = items.map((i) => i.item?.content);
    const command = content.find((c) => c?.case === "commandExecution");
    expect(command?.case === "commandExecution" && command.value.output).toContain("FIXTURE_TOOL_OUTPUT");
    expect(
      content.some((c) => c?.case === "reasoning" && `${c.value.text}${c.value.summary}`.includes("FIXTURE_THINK")),
    ).toBe(true);
    expect(content.filter((c) => c?.case === "agentMessage")).toHaveLength(2);
    // No echo of the prompt as an item: it is the turn's input.
    expect(content.some((c) => c?.case === "userMessage")).toBe(false);
    await f.gw.api.undoImportRun({ runId: done.id });
  }, 60_000);

  test("continues natively: Codex resumes the thread from a copy in Canopy's private CODEX_HOME", async () => {
    const done = await importAll("continue");
    const main = done.items.find((i) => i.cwd.endsWith("project"))!;
    expect(main.continueMode).toBe("native");
    const { thread } = await f.snapshot(main.threadId);
    expect(thread?.import?.mode).toBe("native");

    const sessionId = (
      await f.sql(
        (sql) => sql<{ native_id: string }>`
      SELECT native_id FROM thread_imports WHERE thread_id = ${main.threadId}::uuid`,
      )
    )[0]!.native_id;

    const sessions = join(f.data, "codex-home", "sessions");
    expect(readdirSync(sessions, { recursive: true }).some((p) => String(p).endsWith(`${sessionId}.jsonl`))).toBe(true);

    await f.gw.api.sendMessage({
      threadId: main.threadId,
      text: "Continue with FIXTURE_NEXT",
      clientRequestId: "next",
    });
    await eventually(
      () => f.snapshot(main.threadId),
      (s) => s.turns.some((t) => t.trigger === "user" && t.status === "completed"),
      20_000,
    );
    expect(probeRecords(f.trace).some((r) => r.event === "thread/resume" && r.session === sessionId)).toBe(true);
  }, 60_000);
});
