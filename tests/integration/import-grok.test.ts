import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { probeRecords } from "./fixtures/instance-probe.ts";
import { treeFingerprint } from "../../apps/worker/src/import/fixtures/install.ts";
import { eventually } from "./support/gateway.ts";
import { importFixture } from "./support/imports.ts";

/** CLI import, stage 5 (docs/import.md, "Grok"): Grok sessions into threads that continue in Canopy. */
describe.skipIf(!dockerAvailable)("CLI import: Grok", () => {
  const dir = tempDir("canopy-import-grok-");
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
    f = await importFixture(dir, { clis: ["grok"], grok: true });
  }, 120_000);

  afterEach(async () => {
    await f?.restore();
  });

  afterAll(async () => {
    delete process.env["INSTANCE_TRACE"];
    await f?.close();
  });

  test("imports turns, the terminal command with its output and reasoning, and leaves the sessions untouched", async () => {
    const before = treeFingerprint(join(f.home, ".grok", "sessions"));
    const done = await importAll("history");
    expect(done).toMatchObject({ status: "completed", done: 1, failed: 0 });
    expect(treeFingerprint(join(f.home, ".grok", "sessions"))).toBe(before);
    const main = done.items.find((i) => i.cwd.endsWith("project"))!;
    const { thread, turns, items } = await f.snapshot(main.threadId);
    expect(thread?.import).toMatchObject({ agentCli: "grok", mode: "history" });
    expect(turns.map((t) => [t.inputText, t.status, t.model])).toEqual([
      ["Run the shell tool for FIXTURE_TOOL", "completed", "fixture-grok"],
      ["Think hard about FIXTURE_THINK", "completed", "fixture-grok"],
    ]);
    const content = items.map((i) => i.item?.content);
    const command = content.find((c) => c?.case === "commandExecution");
    expect(command?.case === "commandExecution" && command.value.output).toContain("FIXTURE_TOOL_OUTPUT");
    expect(command?.case === "commandExecution" && command.value.command).toContain("echo FIXTURE_TOOL_OUTPUT");
    expect(
      content.some((c) => c?.case === "reasoning" && `${c.value.text}${c.value.summary}`.includes("FIXTURE_THINK")),
    ).toBe(true);
    expect(content.filter((c) => c?.case === "agentMessage")).toHaveLength(2);
    // No echo of the prompt as an item: it is the turn's input.
    expect(content.some((c) => c?.case === "userMessage")).toBe(false);
    await f.gw.api.undoImportRun({ runId: done.id });
  }, 60_000);

  test("continues natively: Grok loads the session from a copy in the instance's sessions root", async () => {
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

    const sessions = join(f.data, "grok", "native", "sessions");
    expect(
      readdirSync(sessions, { recursive: true }).some((p) => String(p).endsWith(`${sessionId}/chat_history.jsonl`)),
    ).toBe(true);

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
    expect(probeRecords(f.trace).some((r) => r.event === "session/load" && r.session === sessionId)).toBe(true);
  }, 60_000);
});
