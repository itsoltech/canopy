import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { dockerAvailable } from "@canopy/db/testing";
import type { JsonObject } from "@canopy/domain";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { treeFingerprint } from "../../apps/worker/src/import/fixtures/install.ts";
import { eventually, failure } from "./support/gateway.ts";
import { failItem, resumePaused, resumeRun, runnerRunStatus } from "../../apps/gateway/src/imports/transitions.ts";
import { importFixture } from "./support/imports.ts";

/** CLI import, stage 2 (docs/import.md): Claude Code history into Canopy threads over the worker link. */
describe.skipIf(!dockerAvailable)("CLI import: Claude history", () => {
  const dir = tempDir("canopy-import-claude-");
  const CANARY = "sk-ant-api03-CANARYcanaryCANARYcanary0123456789xyz";
  let f: Awaited<ReturnType<typeof importFixture>>;
  let projectDir: string;

  const scan = () => f.gw.api.scanImport({ workerId: f.workerId });

  /** Every run of this owner undone: the next test imports from a clean slate, whatever the last one left. */
  const undoAll = async () => {
    for (const run of (await f.gw.api.listImportRuns({})).runs)
      if (run.status !== "undone") await f.gw.api.undoImportRun({ runId: run.id });
  };

  const runItems = (runId: string) =>
    f.sql(
      (sql) =>
        sql<{
          id: string;
          status: string;
          thread_id: string | null;
        }>`SELECT id, status, thread_id FROM import_items WHERE run_id = ${runId}::uuid ORDER BY id`,
    );

  const all = { allMatching: true, filter: { includeSubagents: true } };

  const finished = (runId: string) =>
    eventually(
      () => f.gw.api.getImportRun({ runId, items: true }),
      (r) => !["running", "paused"].includes(r.status),
      20_000,
    );

  beforeAll(async () => {
    f = await importFixture(dir, { clis: ["claude"] });
    projectDir = join(f.home, ".claude", "projects", f.home.replace(/[^a-zA-Z0-9]/g, "-") + "-project");
  }, 120_000);

  afterEach(async () => {
    await f?.restore();
  });

  afterAll(async () => {
    await f?.close();
  });

  test("imports the whole timeline as history, read-only, with the source's times and untouched files", async () => {
    const before = treeFingerprint(f.home);
    const { scanId } = await scan();
    const run = await f.gw.api.startImport({ scanId, selection: all, mode: "history" });
    expect(run.total).toBe(2);
    const done = await finished(run.id);
    expect(done).toMatchObject({ status: "completed", done: 2, failed: 0 });
    expect(treeFingerprint(f.home)).toBe(before);

    const main = done.items.find((i) => i.cwd === join(f.home, "project"))!;
    const { thread, turns, items } = await f.snapshot(main.threadId);
    expect(thread?.import).toMatchObject({ agentCli: "claude", mode: "history" });
    expect(timestampMs(thread!.createdAt!)).toBeLessThan(Date.now() - 60_000);
    expect(turns.map((t) => [t.trigger, t.inputText, t.status])).toEqual([
      ["import", "Run the shell tool for FIXTURE_TOOL", "completed"],
      ["import", "Think hard about FIXTURE_THINK", "completed"],
      ["import", "Use a subagent for FIXTURE_AGENT", "completed"],
      ["import", "/compact", "completed"],
      ["import", "Continue after compaction with FIXTURE_AFTER", "completed"],
    ]);
    const content = items.map((i) => i.item?.content);
    const command = content.find((c) => c?.case === "commandExecution");
    expect(command?.value).toMatchObject({ command: "echo FIXTURE_TOOL_OUTPUT" });
    expect(command?.case === "commandExecution" && command.value.output).toContain("FIXTURE_TOOL_OUTPUT");
    expect(content.some((c) => c?.case === "reasoning" && c.value.text.includes("FIXTURE_THINK"))).toBe(true);
    const subagent = items.find((i) => i.item?.content.case === "subagent")!;
    expect(items.some((i) => i.item?.parentItemId === subagent.item!.itemId)).toBe(true);
    const compaction = content.find((c) => c?.case === "contextCompaction");
    expect(compaction?.case === "contextCompaction" && compaction.value.summary.length).toBeGreaterThan(0);
    // Imported history is not news.
    expect(thread?.unseenResult).toBeFalsy();
    expect(
      await failure(f.gw.api.sendMessage({ threadId: main.threadId, text: "hi", clientRequestId: "x" })),
    ).toContain("imported as history");
  });

  test("importing again does not duplicate; a page read again stores nothing twice", async () => {
    const { scanId } = await scan();
    expect(await failure(f.gw.api.startImport({ scanId, selection: all }))).toContain("already imported");
    const listed = await f.gw.api.listImportCandidates({ scanId, filter: { includeSubagents: true } });
    expect(listed.candidates.every((c) => c.status === "imported" && c.threadId)).toBe(true);

    const runId = (await f.gw.api.listImportRuns({})).runs[0]!.id;
    const thread = listed.candidates.find((c) => c.cwd.endsWith("project"))!.threadId;

    const count = async () =>
      f.sql(
        (sql) => sql<{ turns: number; events: number }>`
        SELECT (SELECT count(*)::int FROM turns WHERE thread_id = ${thread}::uuid) AS turns,
               (SELECT count(*)::int FROM thread_events WHERE thread_id = ${thread}::uuid) AS events`,
      );

    const before = (await count())[0];
    // Back to the start: every page is read and ingested again.
    await f.sql((sql) => sql`UPDATE import_items SET status = 'failed', cursor = '' WHERE thread_id = ${thread}::uuid`);
    await f.sql((sql) => sql`UPDATE import_runs SET status = 'completed' WHERE id = ${runId}::uuid`);
    await f.gw.api.resumeImportRun({ runId });
    expect((await finished(runId)).status).toBe("completed");
    expect((await count())[0]).toEqual(before);
  });

  test("a run pauses when its worker goes away and continues from its cursor", async () => {
    await undoAll();
    f.gw.core.imports.runner.pageBytes = 1;
    const { scanId } = await scan();
    const run = await f.gw.api.startImport({ scanId, selection: all, mode: "history" });
    await eventually(
      () =>
        f.sql(
          (sql) =>
            sql<{ cursor: string }>`SELECT cursor FROM import_items WHERE run_id = ${run.id}::uuid AND cursor <> ''`,
        ),
      (rows) => rows.length > 0,
    );
    f.disconnect();
    await eventually(
      () => f.gw.api.getImportRun({ runId: run.id }),
      (r) => r.status === "paused",
      10_000,
    );
    await f.connect();
    const done = await finished(run.id);
    expect(done).toMatchObject({ status: "completed", done: 2 });
    const main = done.items.find((i) => i.cwd.endsWith("project"))!;
    expect((await f.snapshot(main.threadId)).turns).toHaveLength(5);
    f.gw.core.imports.runner.pageBytes = 4 * 1024 ** 2;
  });

  test("cancelling a paused run removes the thread being imported and frees its source, with no runner", async () => {
    await undoAll();
    f.gw.core.imports.runner.pageBytes = 1;
    // One page in, the worker goes away: exactly one thread is being imported, whichever finished first.
    f.offlineAtPage(2);
    const { scanId } = await scan();
    const run = await f.gw.api.startImport({ scanId, selection: all, mode: "history" });
    await eventually(
      () => f.gw.api.getImportRun({ runId: run.id }),
      (r) => r.status === "paused",
      10_000,
    );

    const statuses = await runItems(run.id);
    const half = statuses.filter((i) => i.status === "importing");
    expect(half).toHaveLength(1);

    expect((await f.gw.api.cancelImportRun({ runId: run.id })).status).toBe("cancelled");

    const after = await f.sql(
      (sql) => sql<{ id: string; status: string; deleted: boolean }>`
        SELECT i.id, i.status, t.deleted_at IS NOT NULL AS deleted FROM import_items i
          LEFT JOIN threads t ON t.id = i.thread_id WHERE i.run_id = ${run.id}::uuid`,
    );

    // A thread already imported stays; the one being imported and the pending ones are cancelled.
    expect(after.map((i) => [i.id, i.status])).toEqual(
      statuses.map((i) => [i.id, i.status === "done" ? "done" : "cancelled"]),
    );
    expect(after.filter((i) => i.deleted)).toHaveLength(1);

    // Nothing more is written for a cancelled run once its worker is back.
    const events = await f.sql(
      (sql) =>
        sql<{ n: number }>`SELECT count(*)::int AS n FROM thread_events WHERE thread_id = ${half[0]!.thread_id}::uuid`,
    );

    await f.connect();
    await f.gw.core.imports.runner.tick();
    await f.gw.core.imports.runner.drive(run.id);

    const again = await f.sql(
      (sql) =>
        sql<{ n: number }>`SELECT count(*)::int AS n FROM thread_events WHERE thread_id = ${half[0]!.thread_id}::uuid`,
    );

    expect(again[0]!.n).toBe(events[0]!.n);
    f.gw.core.imports.runner.pageBytes = 4 * 1024 ** 2;
    // The sources are free: a new run imports them.
    const fresh = await f.gw.api.startImport({ scanId: (await scan()).scanId, selection: all, mode: "history" });
    expect((await finished(fresh.id)).status).toBe("completed");
  });

  test("a late failure, pause or resume decided before a cancel leaves the cancelled run and its items as they are", async () => {
    await undoAll();
    f.gw.core.imports.runner.pageBytes = 1;
    f.offlineAtPage(2);
    const run = await f.gw.api.startImport({ scanId: (await scan()).scanId, selection: all, mode: "history" });
    await eventually(
      () => f.gw.api.getImportRun({ runId: run.id }),
      (r) => r.status === "paused",
      10_000,
    );
    await f.gw.api.cancelImportRun({ runId: run.id });
    const cancelled = await runItems(run.id);

    const itemIds = await f.sql(
      (sql) => sql<{ id: string }>`SELECT id FROM import_items WHERE run_id = ${run.id}::uuid`,
    );

    // What the runner does when a page it sent before the cancel comes back with an error, or the worker goes away.
    for (const { id } of itemIds)
      expect((await f.sql((sql) => failItem(sql, id, "the source changed"))).failed).toBe(false);
    expect(await f.sql((sql) => runnerRunStatus(sql, run.id, "paused", "offline"))).toBe(false);
    // A resume decided on a stale read (the periodic check listed the run as paused, Resume saw it paused).
    expect(await f.sql((sql) => resumePaused(sql, run.id))).toBe(false);
    expect(await f.sql((sql) => resumeRun(sql, f.gw.userId, run.id))).toBe(false);
    await f.gw.core.imports.runner.tick();
    const after = await f.gw.api.getImportRun({ runId: run.id, items: true });
    expect(after.status).toBe("cancelled");
    // Every item is as the cancellation left it (a thread finished before stays done).
    expect((await runItems(run.id)).map((i) => [i.id, i.status])).toEqual(cancelled.map((i) => [i.id, i.status]));
    expect(cancelled.filter((i) => i.status !== "done").every((i) => i.status === "cancelled")).toBe(true);
  });

  test("undo deletes the run's threads and frees their sources", async () => {
    await undoAll();

    const runId = (await finished((await f.gw.api.startImport({ scanId: (await scan()).scanId, selection: all })).id))
      .id;

    const threads = (await f.gw.api.getImportRun({ runId, items: true })).items.map((i) => i.threadId);
    expect((await f.gw.api.undoImportRun({ runId })).status).toBe("undone");
    const listed = new Set((await f.gw.api.listThreads({})).threads.map((t) => t.id));
    expect(threads.some((id) => listed.has(id))).toBe(false);
    const { scanId } = await scan();
    const candidates = await f.gw.api.listImportCandidates({ scanId, filter: { includeSubagents: true } });
    expect(candidates.candidates.every((c) => c.status === "new")).toBe(true);
  });

  test("masks secrets in imported timelines, reports broken lines, and fails only a changed source", async () => {
    await undoAll();
    const session = readdirSync(projectDir).find((n) => n.endsWith(".jsonl"))!;
    const id = crypto.randomUUID();

    const entry = (extra: JsonObject) =>
      `${JSON.stringify({ sessionId: id, cwd: join(f.home, "project"), version: "2.1.308", timestamp: "2026-11-02T10:00:00Z", ...extra })}\n`;

    writeFileSync(
      join(projectDir, `${id}.jsonl`),
      entry({
        type: "user",
        uuid: "u1",
        parentUuid: "",
        message: { role: "user", content: `deploy FIXTURE_SECRET with ${CANARY}` },
      }) +
        "{not json\n" +
        entry({
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          message: { id: "m1", role: "assistant", content: [{ type: "text", text: `Used ${CANARY}` }] },
        }),
    );
    const { scanId } = await scan();
    // The main session grows a different prefix after the scan: its import fails, the others continue.
    const mainPath = join(projectDir, session);
    const original = await Bun.file(mainPath).text();
    writeFileSync(mainPath, `{"type":"summary","summary":"rewritten"}\n${original}`);
    const run = await f.gw.api.startImport({ scanId, selection: all, mode: "history" });
    const done = await finished(run.id);
    writeFileSync(mainPath, original);
    expect(done).toMatchObject({ done: 2, failed: 1 });
    expect(done.items.find((i) => i.status === "failed")?.error).toContain("changed since the scan");
    const planted = done.items.find((i) => i.title.includes("FIXTURE_SECRET"))!;
    expect(planted.warnings).toContain("1 line could not be read");

    const leaks = await f.sql(
      (sql) => sql`
      SELECT 1 FROM thread_events WHERE payload::text LIKE ${`%${CANARY}%`} OR coalesce(raw::text, '') LIKE ${`%${CANARY}%`}
      UNION ALL SELECT 1 FROM thread_items WHERE content::text LIKE ${`%${CANARY}%`}
      UNION ALL SELECT 1 FROM turns WHERE input::text LIKE ${`%${CANARY}%`}
      UNION ALL SELECT 1 FROM import_items WHERE title LIKE ${`%${CANARY}%`}`,
    );

    expect(leaks).toHaveLength(0);
    const { turns } = await f.snapshot(planted.threadId);
    expect(turns[0]?.inputText).toContain("[redacted]");
    appendFileSync(mainPath, "");
  });

  test("owner scoping: another owner's run is invisible; a key not in the scan selects nothing", async () => {
    const other = await f.gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("import-other@localhost", "Other")),
    );

    const runId = Bun.randomUUIDv7();
    await f.sql(
      (sql) => sql`
      INSERT INTO import_runs (id, owner_user_id, worker_id, status, mode) VALUES (${runId}::uuid, ${other}::uuid, ${f.workerId}::uuid, 'completed', 'history')`,
    );
    expect(await failure(f.gw.api.getImportRun({ runId }))).toContain("Import not found");
    expect(await failure(f.gw.api.undoImportRun({ runId }))).toContain("Import not found");
    expect((await f.gw.api.listImportRuns({})).runs.some((r) => r.id === runId)).toBe(false);
    const { scanId } = await scan();
    expect(await failure(f.gw.api.startImport({ scanId, selection: { included: ["forged.key.value"] } }))).toContain(
      "Choose at least one thread",
    );
  });
});
