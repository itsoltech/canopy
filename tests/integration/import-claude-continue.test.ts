import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dockerAvailable } from "@canopy/db/testing";
import type { JsonObject } from "@canopy/domain";
import { GatewayStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { tempDir } from "@canopy/testing";
import { violates } from "../../apps/gateway/src/core/core-context.ts";
import { probeRecords } from "./fixtures/instance-probe.ts";
import { treeFingerprint } from "../../apps/worker/src/import/fixtures/install.ts";
import { eventually, failure } from "./support/gateway.ts";
import { importFixture } from "./support/imports.ts";

/** CLI import, stage 3 (docs/import.md, "Kontynuacja"): imported Claude threads continue in Canopy. */
describe.skipIf(!dockerAvailable)("CLI import: continuing Claude threads", () => {
  const dir = tempDir("canopy-import-continue-");
  let f: Awaited<ReturnType<typeof importFixture>>;
  let runId = "";
  const threads = new Map<string, string>();

  const finished = (id: string) =>
    eventually(
      () => f.gw.api.getImportRun({ runId: id, items: true }),
      (r) => !["running", "paused"].includes(r.status),
      20_000,
    );

  const copyOf = (sessionId: string) => {
    const projects = join(f.data, "claude-home", "projects");

    return existsSync(projects)
      ? readdirSync(projects)
          .map((d) => join(projects, d, `${sessionId}.jsonl`))
          .find(existsSync)
      : undefined;
  };

  const sourceOf = (cwd: string) => {
    const dirName = join(f.home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));

    return join(
      dirName,
      readdirSync(dirName).find((n) => n.endsWith(".jsonl"))!,
    );
  };

  beforeAll(async () => {
    f = await importFixture(dir, { clis: ["claude"], claude: true });
    const { scanId } = await f.gw.api.scanImport({ workerId: f.workerId });
    const run = await f.gw.api.startImport({ scanId, selection: { allMatching: true, filter: {} } });
    runId = run.id;
    const done = await finished(run.id);

    for (const item of done.items) threads.set(item.cwd.endsWith("project") ? "main" : "other", item.threadId);
  }, 120_000);

  afterEach(async () => {
    await f?.restore();
  });

  afterAll(async () => {
    delete process.env["INSTANCE_TRACE"];
    await f?.close();
  }, 60_000);

  test("imports natively: the thread resumes a private copy of the session", async () => {
    const run = await f.gw.api.getImportRun({ runId, items: true });
    expect(run.items.map((i) => i.continueMode)).toEqual(["native", "native"]);
    const { thread } = await f.snapshot(threads.get("main")!);
    expect(thread?.import).toMatchObject({ agentCli: "claude", mode: "native" });

    const sessionId = (
      await f.sql(
        (sql) => sql<{ native_id: string }>`
      SELECT native_id FROM thread_imports WHERE thread_id = ${threads.get("main")!}::uuid`,
      )
    )[0]!.native_id;

    expect(copyOf(sessionId)).toBeDefined();

    const before = treeFingerprint(join(f.home, ".claude"));
    await f.gw.api.sendMessage({
      threadId: threads.get("main")!,
      text: "Continue with FIXTURE_NEXT",
      clientRequestId: "next",
    });
    await eventually(
      () => f.snapshot(threads.get("main")!),
      (s) => s.turns.some((t) => t.trigger === "user" && t.status === "completed"),
      20_000,
    );
    // The fake Claude Code was started with --resume of the imported session, in Canopy's private home.
    const resumed = probeRecords(f.trace).find((r) => r.event === "resume" && r.session === sessionId);
    expect(resumed?.home).toBe(join(f.data, "claude-home"));
    expect(await Bun.file(copyOf(sessionId)!).text()).toContain("FIXTURE_NEXT");
    expect(treeFingerprint(join(f.home, ".claude"))).toBe(before);
  }, 60_000);

  test("continue in a new thread: the new session's instructions carry a note about the history", async () => {
    const response = await f.gw.api.continueImportedThread({ threadId: threads.get("main")! });
    const created = response.thread!;
    expect(created.title).toContain("(continued)");
    const row = await f.gw.runtime.runPromise(GatewayStore.use((s) => s.thread(created.id)));

    // ThreadSpec.instructions of its first turn: the moved-thread handoff path (threads-store.ts).
    const instructions = (await f.gw.runtime.runPromise(GatewayStore.use((s) => Effect.succeed(s.threadSpec(row)))))
      .instructions;

    expect(instructions).toContain("imported from Claude Code");
    expect(instructions).toContain("User: Run the shell tool for FIXTURE_TOOL");
    expect(instructions).toContain("Assistant: FIXTURE_ANSWER");
  }, 60_000);

  test("turns the CLI adds later join the same thread, and its copy grows", async () => {
    const other = sourceOf(join(f.home, "other"));
    const sessionId = other.slice(other.lastIndexOf("/") + 1, -".jsonl".length);

    const last = (await Bun.file(other).text())
      .trim()
      .split("\n")
      .reverse()
      .map((l) => JSON.parse(l) as { uuid?: string })
      .find((e) => e.uuid)!.uuid!;

    const entry = (type: string, uuid: string, parentUuid: string, content: string | object[]) =>
      `${JSON.stringify({ type, uuid, parentUuid, sessionId, cwd: join(f.home, "other"), version: "2.1.308", timestamp: new Date().toISOString(), message: type === "user" ? { role: "user", content } : { id: `m-${uuid}`, role: "assistant", content, stop_reason: "end_turn" } })}\n`;

    appendFileSync(
      other,
      entry("user", "later-u", last, "Later prompt FIXTURE_LATER") +
        entry("assistant", "later-a", "later-u", [{ type: "text", text: "Later answer" }]),
    );

    const { scanId } = await f.gw.api.scanImport({ workerId: f.workerId });
    const listed = await f.gw.api.listImportCandidates({ scanId });
    const grown = listed.candidates.find((c) => c.nativeId === sessionId)!;
    expect(grown.status).toBe("has_new_turns");
    // The main thread took a turn in Canopy: its copy and the CLI's file went separate ways.
    expect(listed.candidates.find((c) => c.threadId === threads.get("main"))?.status).toBe("imported");

    const run = await f.gw.api.startImport({ scanId, selection: { included: [grown.sourceKey] } });
    expect((await finished(run.id)).items[0]).toMatchObject({ status: "done", threadId: threads.get("other") });
    const { turns } = await f.snapshot(threads.get("other")!);
    expect(turns.map((t) => t.inputText)).toEqual(["Hello from FIXTURE_OTHER", "Later prompt FIXTURE_LATER"]);
    expect(await Bun.file(copyOf(sessionId)!).text()).toContain("FIXTURE_LATER");
  }, 60_000);

  test("a thread being imported takes no turns, from any path, until its import is done", async () => {
    const thread = threads.get("other")!;
    await f.sql(
      (sql) => sql`UPDATE import_items SET status = 'importing' WHERE thread_id = ${thread}::uuid AND status = 'done'`,
    );

    try {
      expect(
        await failure(f.gw.api.sendMessage({ threadId: thread, text: "too early", clientRequestId: "early" })),
      ).toContain("still being imported");

      // Any other path that adds a turn (schedules, agents) meets the database's gate.
      const direct = await f
        .sql(
          (sql) => sql`
            INSERT INTO turns (id, thread_id, ordinal, trigger, input)
            VALUES (${Bun.randomUUIDv7()}::uuid, ${thread}::uuid, 999, 'schedule', '{}'::jsonb)`,
        )
        .then(
          () => "inserted",
          (cause: unknown) => (violates(cause, "import_turn_gate") ? "refused" : String(cause)),
        );

      expect(direct).toBe("refused");
    } finally {
      await f.sql(
        (sql) =>
          sql`UPDATE import_items SET status = 'done' WHERE thread_id = ${thread}::uuid AND status = 'importing'`,
      );
    }
  });

  test("a session that cannot be masked record by record continues in a new thread, with the reason", async () => {
    const dirName = join(f.home, ".claude", "projects", join(f.home, "project").replace(/[^a-zA-Z0-9]/g, "-"));
    const id = crypto.randomUUID();

    const entry = (extra: JsonObject) =>
      `${JSON.stringify({ sessionId: id, cwd: join(f.home, "project"), version: "2.1.308", timestamp: "2026-11-03T10:00:00Z", ...extra })}\n`;

    writeFileSync(
      join(dirName, `${id}.jsonl`),
      entry({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "UNMASKABLE_PROMPT" } }) +
        "{not json\n" +
        entry({
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          message: { id: "m1", role: "assistant", content: [{ type: "text", text: "ok" }] },
        }),
    );
    const { scanId } = await f.gw.api.scanImport({ workerId: f.workerId });

    const run = await f.gw.api.startImport({
      scanId,
      selection: { allMatching: true, filter: { search: "UNMASKABLE_PROMPT" } },
    });

    const item = (await finished(run.id)).items[0]!;

    expect(item).toMatchObject({ status: "done", continueMode: "history" });
    expect(item.warnings.join(" ")).toContain("Continues in a new thread");
    expect(item.warnings.join(" ")).toContain("can't be masked");
    expect((await f.snapshot(item.threadId)).thread?.import?.mode).toBe("history");
    expect(copyOf(id)).toBeUndefined();
  }, 60_000);

  test("a last turn the CLI was still writing gets the steps that finished it when its new turns are imported", async () => {
    const dirName = join(f.home, ".claude", "projects", join(f.home, "project").replace(/[^a-zA-Z0-9]/g, "-"));
    const id = crypto.randomUUID();
    const path = join(dirName, `${id}.jsonl`);

    const entry = (extra: JsonObject) =>
      `${JSON.stringify({ sessionId: id, cwd: join(f.home, "project"), version: "2.1.308", timestamp: "2026-11-03T10:00:00Z", ...extra })}\n`;

    const prompt = entry({
      type: "user",
      uuid: "u1",
      parentUuid: null,
      message: { role: "user", content: "APPEND_FIRST" },
    });

    const call = entry({
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      message: {
        id: "m1",
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      },
    });

    const result = entry({
      type: "user",
      uuid: "r1",
      parentUuid: "a1",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "APPEND_OUTPUT" }] },
    });

    writeFileSync(path, prompt + call + result.slice(0, 30));
    const selection = { allMatching: true, filter: { search: "APPEND_FIRST" } };

    const first = await f.gw.api.startImport({
      scanId: (await f.gw.api.scanImport({ workerId: f.workerId })).scanId,
      selection,
      mode: "history",
    });

    const item = (await finished(first.id)).items[0]!;
    appendFileSync(
      path,
      result.slice(30) +
        entry({ type: "user", uuid: "u2", parentUuid: "r1", message: { role: "user", content: "APPEND_SECOND" } }),
    );

    const { scanId } = await f.gw.api.scanImport({ workerId: f.workerId });
    expect(
      (await f.gw.api.listImportCandidates({ scanId, filter: { search: "APPEND_FIRST" } })).candidates[0]?.status,
    ).toBe("has_new_turns");
    await finished((await f.gw.api.startImport({ scanId, selection, mode: "history" })).id);
    const { turns, items } = await f.snapshot(item.threadId);

    expect(turns.map((t) => t.inputText)).toEqual(["APPEND_FIRST", "APPEND_SECOND"]);
    const command = items.find((i) => i.item?.content.case === "commandExecution")!;
    expect(command.item?.content.case === "commandExecution" && command.item.content.value.output).toContain(
      "APPEND_OUTPUT",
    );
  }, 60_000);

  test("cancelling or undoing an append keeps the history imported before", async () => {
    const dirName = join(f.home, ".claude", "projects", join(f.home, "project").replace(/[^a-zA-Z0-9]/g, "-"));
    const id = crypto.randomUUID();
    const path = join(dirName, `${id}.jsonl`);

    const entry = (extra: JsonObject) =>
      `${JSON.stringify({ sessionId: id, cwd: join(f.home, "project"), version: "2.1.308", timestamp: "2026-11-04T10:00:00Z", ...extra })}\n`;

    const turnOf = (n: number, parent: string | null) =>
      entry({ type: "user", uuid: `u${n}`, parentUuid: parent, message: { role: "user", content: `KEEP_${n}` } }) +
      entry({
        type: "assistant",
        uuid: `a${n}`,
        parentUuid: `u${n}`,
        message: { id: `m${n}`, role: "assistant", content: [{ type: "text", text: `answer ${n}` }] },
      });

    writeFileSync(path, turnOf(1, null) + turnOf(2, "a1"));
    const selection = { allMatching: true, filter: { search: "KEEP_1" } };
    const scan = async () => (await f.gw.api.scanImport({ workerId: f.workerId })).scanId;
    const first = (await finished((await f.gw.api.startImport({ scanId: await scan(), selection })).id)).items[0]!;
    const before = await f.snapshot(first.threadId);
    expect(before.turns.map((t) => t.inputText)).toEqual(["KEEP_1", "KEEP_2"]);

    appendFileSync(path, Array.from({ length: 300 }, (_, n) => turnOf(n + 3, `a${n + 2}`)).join(""));
    f.gw.core.imports.runner.pageBytes = 1;
    const append = await f.gw.api.startImport({ scanId: await scan(), selection });
    await eventually(
      () => f.snapshot(first.threadId),
      (s) => s.turns.length >= 3,
      10_000,
    );
    f.disconnect();
    await eventually(
      () => f.gw.api.getImportRun({ runId: append.id }),
      (r) => r.status === "paused",
      10_000,
    );
    expect((await f.gw.api.cancelImportRun({ runId: append.id })).status).toBe("cancelled");
    await f.connect();
    f.gw.core.imports.runner.pageBytes = 4 * 1024 ** 2;

    // The thread is as the first import left it: its turns, its items, and the first import owns it again.
    const after = await f.snapshot(first.threadId);
    expect(after.thread?.id).toBe(first.threadId);
    expect(after.turns.map((t) => t.inputText)).toEqual(["KEEP_1", "KEEP_2"]);
    expect(after.items.length).toBe(before.items.length);
    const listed = await f.gw.api.listImportCandidates({ scanId: await scan(), filter: { search: "KEEP_1" } });
    expect(listed.candidates[0]?.status).toBe("has_new_turns");

    // Undo of a finished append: the same, and a thread that resumes natively continues in a new one.
    const done = await finished((await f.gw.api.startImport({ scanId: await scan(), selection })).id);
    expect((await f.snapshot(first.threadId)).turns).toHaveLength(302);
    await f.gw.api.undoImportRun({ runId: done.id });
    const undone = await f.snapshot(first.threadId);
    expect(undone.turns.map((t) => t.inputText)).toEqual(["KEEP_1", "KEEP_2"]);
    expect(undone.thread?.import?.mode).toBe("history");
  }, 90_000);

  test("appends: cancelling a running one keeps the thread, a failed one is undone, undo stops at Canopy turns", async () => {
    const dirName = join(f.home, ".claude", "projects", join(f.home, "project").replace(/[^a-zA-Z0-9]/g, "-"));
    const id = crypto.randomUUID();
    const path = join(dirName, `${id}.jsonl`);

    const entry = (extra: JsonObject) =>
      `${JSON.stringify({ sessionId: id, cwd: join(f.home, "project"), version: "2.1.308", timestamp: "2026-11-06T10:00:00Z", ...extra })}\n`;

    const turnOf = (n: number, parent: string | null) =>
      entry({ type: "user", uuid: `u${n}`, parentUuid: parent, message: { role: "user", content: `APPEND3_${n}` } }) +
      entry({
        type: "assistant",
        uuid: `a${n}`,
        parentUuid: `u${n}`,
        message: { id: `m${n}`, role: "assistant", content: [{ type: "text", text: `answer ${n}` }] },
      });

    const more = (from: number, count: number) =>
      Array.from({ length: count }, (_, n) => turnOf(from + n, `a${from + n - 1}`)).join("");

    writeFileSync(path, turnOf(1, null));
    const selection = { allMatching: true, filter: { search: "APPEND3_1" } };
    const scan = async () => (await f.gw.api.scanImport({ workerId: f.workerId })).scanId;
    const first = (await finished((await f.gw.api.startImport({ scanId: await scan(), selection })).id)).items[0]!;
    const turns = async () => (await f.snapshot(first.threadId)).turns.map((t) => t.inputText);

    // Cancelled while its runner is at work: the thread stays as the first import left it (H3).
    appendFileSync(path, more(2, 300));
    f.gw.core.imports.runner.pageBytes = 1;
    const running = await f.gw.api.startImport({ scanId: await scan(), selection });
    await eventually(
      () => turns(),
      (t) => t.length >= 4,
      10_000,
    );
    await f.gw.api.cancelImportRun({ runId: running.id });
    await f.gw.core.imports.runner.drive(running.id);
    await Bun.sleep(300);
    expect(await turns()).toEqual(["APPEND3_1"]);
    expect((await f.snapshot(first.threadId)).thread?.id).toBe(first.threadId);

    // Failed halfway (the file was rewritten while the run was paused): Undo puts the thread back and the first
    // import owns it (M1).
    const failing = await f.gw.api.startImport({ scanId: await scan(), selection });
    await eventually(
      () => turns(),
      (t) => t.length >= 4,
      10_000,
    );
    f.disconnect();
    await eventually(
      () => f.gw.api.getImportRun({ runId: failing.id }),
      (r) => r.status === "paused",
      10_000,
    );
    writeFileSync(path, `${(await Bun.file(path).text()).replace("APPEND3_1", "APPEND3_X")}`);
    await f.connect();
    const failed = await finished(failing.id);
    expect(failed.items[0]?.status).toBe("failed");
    expect((await turns()).length).toBeGreaterThan(1);
    await f.gw.api.undoImportRun({ runId: failing.id });
    expect(await turns()).toEqual(["APPEND3_1"]);
    expect(
      (await f.sql((sql) => sql<{ status: string }>`SELECT status FROM import_items WHERE id = ${first.id}::uuid`))[0]
        ?.status,
    ).toBe("done");
    f.gw.core.imports.runner.pageBytes = 4 * 1024 ** 2;

    // Finished, then continued in Canopy: Undo is refused and nothing is removed (H2).
    writeFileSync(path, turnOf(1, null) + more(2, 2));
    const done = await finished((await f.gw.api.startImport({ scanId: await scan(), selection })).id);
    expect(await turns()).toEqual(["APPEND3_1", "APPEND3_2", "APPEND3_3"]);
    await f.gw.api.sendMessage({
      threadId: first.threadId,
      text: "Continue with FIXTURE_NEXT",
      clientRequestId: "after-append",
    });
    await eventually(
      () => f.snapshot(first.threadId),
      (s) => s.turns.some((t) => t.trigger === "user" && t.status === "completed"),
      20_000,
    );
    expect(await failure(f.gw.api.undoImportRun({ runId: done.id }))).toContain(
      "Can't undo: the thread continued after this import.",
    );
    expect((await turns()).slice(0, 3)).toEqual(["APPEND3_1", "APPEND3_2", "APPEND3_3"]);
    expect((await f.snapshot(first.threadId)).turns.some((t) => t.trigger === "user")).toBe(true);
  }, 120_000);

  test("starting an append while the previous one is undone never deadlocks", async () => {
    const dirName = join(f.home, ".claude", "projects", join(f.home, "project").replace(/[^a-zA-Z0-9]/g, "-"));
    const id = crypto.randomUUID();
    const path = join(dirName, `${id}.jsonl`);

    const entry = (extra: JsonObject) =>
      `${JSON.stringify({ sessionId: id, cwd: join(f.home, "project"), version: "2.1.308", timestamp: "2026-11-07T10:00:00Z", ...extra })}\n`;

    const turnOf = (n: number, parent: string | null) =>
      entry({ type: "user", uuid: `u${n}`, parentUuid: parent, message: { role: "user", content: `RACE_${n}` } });

    const selection = { allMatching: true, filter: { search: "RACE_1" } };
    const scan = async () => (await f.gw.api.scanImport({ workerId: f.workerId })).scanId;
    writeFileSync(path, turnOf(1, null));
    await finished((await f.gw.api.startImport({ scanId: await scan(), selection, mode: "history" })).id);
    let next = 2;

    for (let round = 0; round < 4; round++) {
      appendFileSync(path, turnOf(next, `u${next - 1}`));
      next += 1;

      const appended = await finished(
        (await f.gw.api.startImport({ scanId: await scan(), selection, mode: "history" })).id,
      );

      appendFileSync(path, turnOf(next, `u${next - 1}`));
      next += 1;
      const scanId = await scan();

      // Both at once: each either wins or says what to do; neither fails inside the database.
      const outcomes = await Promise.all([
        failure(f.gw.api.undoImportRun({ runId: appended.id })),
        failure(f.gw.api.startImport({ scanId, selection, mode: "history" }).then((r) => finished(r.id))),
      ]);

      for (const outcome of outcomes) expect(outcome).not.toContain("internal");
    }
  }, 120_000);

  test("a native thread without its adopted session takes no turns", async () => {
    f.gw.core.imports.runner.pageBytes = 1;
    const dirName = join(f.home, ".claude", "projects", join(f.home, "project").replace(/[^a-zA-Z0-9]/g, "-"));
    const id = crypto.randomUUID();

    const entry = (extra: JsonObject) =>
      `${JSON.stringify({ sessionId: id, cwd: join(f.home, "project"), version: "2.1.308", timestamp: "2026-11-05T10:00:00Z", ...extra })}\n`;

    writeFileSync(
      join(dirName, `${id}.jsonl`),
      entry({ type: "user", uuid: "u0", parentUuid: null, message: { role: "user", content: "NOSESSION_1" } }) +
        Array.from({ length: 300 }, (_, n) =>
          entry({
            type: "user",
            uuid: `u${n + 1}`,
            parentUuid: `u${n}`,
            message: { role: "user", content: `more ${n}` },
          }),
        ).join(""),
    );

    const run = await f.gw.api.startImport({
      scanId: (await f.gw.api.scanImport({ workerId: f.workerId })).scanId,
      selection: { allMatching: true, filter: { search: "NOSESSION_1" } },
    });

    const thread = (
      await eventually(
        () =>
          f.sql(
            (sql) =>
              sql<{ thread_id: string | null }>`SELECT thread_id FROM import_items WHERE run_id = ${run.id}::uuid`,
          ),
        (rows) => Boolean(rows[0]?.thread_id),
      )
    )[0]!.thread_id!;

    f.disconnect();
    await eventually(
      () => f.gw.api.getImportRun({ runId: run.id }),
      (r) => r.status === "paused",
      10_000,
    );
    // As if the import had failed: the item no longer holds the gate, and no session was adopted.
    await f.sql((sql) => sql`UPDATE import_items SET status = 'failed' WHERE run_id = ${run.id}::uuid`);

    const direct = await f
      .sql(
        (sql) => sql`
          INSERT INTO turns (id, thread_id, ordinal, trigger, input)
          VALUES (${Bun.randomUUIDv7()}::uuid, ${thread}::uuid, 999, 'user', '{}'::jsonb)`,
      )
      .then(
        () => "inserted",
        (cause: unknown) => (violates(cause, "import_turn_gate") ? "refused" : String(cause)),
      );

    expect(direct).toBe("refused");
    await f.connect();
    f.gw.core.imports.runner.pageBytes = 4 * 1024 ** 2;
    await f.gw.api.cancelImportRun({ runId: run.id }).catch(() => undefined);
  }, 60_000);

  test("undo removes copies nobody continued, and keeps the one a Canopy turn used", async () => {
    const main = (
      await f.sql(
        (sql) =>
          sql<{
            native_id: string;
          }>`SELECT native_id FROM thread_imports WHERE thread_id = ${threads.get("main")!}::uuid`,
      )
    )[0]!.native_id;

    const other = (
      await f.sql(
        (sql) =>
          sql<{
            native_id: string;
          }>`SELECT native_id FROM thread_imports WHERE thread_id = ${threads.get("other")!}::uuid`,
      )
    )[0]!.native_id;

    // Runs whose thread went on in Canopy refuse Undo (tested above); the rest are undone.
    for (const run of (await f.gw.api.listImportRuns({})).runs)
      await f.gw.api.undoImportRun({ runId: run.id }).catch((cause: unknown) => {
        if (!String(cause).includes("Can't undo")) throw cause;
      });
    expect(copyOf(other)).toBeUndefined();
    expect(copyOf(main)).toBeDefined();
  }, 60_000);
});
