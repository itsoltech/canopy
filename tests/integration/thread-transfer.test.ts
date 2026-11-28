import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PermissionMode, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { startWorker } from "./support/transfer-worker.ts";
import { commit, git } from "./support/worktrees.ts";

/**
 * Moving a thread to another worker of the same gateway (docs/thread-transfers.md): two real workers with real Git
 * and a Codex wire fixture. The move carries the conversation's session, unpushed commits, staged, unstaged and new
 * files and a chosen .env; the next turn resumes the same Codex thread in the new worktree on the other worker. A
 * move that fails after the freeze rolls back and leaves the thread working where it was.
 */

describe.skipIf(!dockerAvailable)("moving a thread to another worker", () => {
  const dir = tempDir("canopy-thread-transfer-");
  const previousTrace = process.env["INSTANCE_TRACE"];
  let gw: TestGateway;
  let a: Awaited<ReturnType<typeof startWorker>>;
  let b: Awaited<ReturnType<typeof startWorker>>;
  let project: ui.Project;
  let workspaceA: ui.Workspace;
  let workspaceB: ui.Workspace;
  let plainB: ui.Workspace;

  const sql = <A>(query: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
    gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, query));

  const thread = (id: string) => gw.runtime.runPromise(GatewayStore.use((s) => s.thread(id)));

  beforeAll(async () => {
    process.env["INSTANCE_TRACE"] = join(dir, "trace.jsonl");
    const origin = join(dir, "origin.git");
    const seed = join(dir, "seed");
    git(dir, "init", "-q", "--bare", "-b", "main", origin);
    git(dir, "clone", "-q", origin, seed);
    writeFileSync(join(seed, ".gitignore"), ".env\nnode_modules/\n");
    git(seed, "add", ".gitignore");
    commit(seed, "app.txt", "one\ntwo\n");
    git(seed, "push", "-qu", "origin", "main");
    const repoA = join(dir, "repo-a");
    const repoB = join(dir, "repo-b");
    const plain = join(dir, "plain-b");
    git(dir, "clone", "-q", origin, repoA);
    git(dir, "clone", "-q", origin, repoB);
    mkdirSync(plain);
    gw = await startTestGateway();
    a = await startWorker(gw, join(dir, "a"), "Laptop");
    b = await startWorker(gw, join(dir, "b"), "Office");
    project = (await gw.api.createProject({ name: "Transfer" })).project!;
    workspaceA = (await gw.api.createWorkspace({ projectId: project.id, workerId: a.workerId, rootPath: repoA }))
      .workspace!;
    workspaceB = (await gw.api.createWorkspace({ projectId: project.id, workerId: b.workerId, rootPath: repoB }))
      .workspace!;
    plainB = (await gw.api.createWorkspace({ projectId: project.id, workerId: b.workerId, rootPath: plain }))
      .workspace!;
  }, 120_000);

  afterAll(async () => {
    try {
      await a?.close();
      await b?.close();
      await gw?.close();
    } finally {
      if (previousTrace === undefined) delete process.env["INSTANCE_TRACE"];
      else process.env["INSTANCE_TRACE"] = previousTrace;
    }
  });

  async function settledTurn(threadId: string, turnId: string) {
    const turns = await eventually(
      () => gw.runtime.runPromise(GatewayStore.use((s) => s.turnsOf(threadId))),
      (rows) => rows.some((t) => t.id === turnId && ["completed", "failed"].includes(t.status)),
      20_000,
    );

    expect(turns.find((t) => t.id === turnId)?.status).toBe("completed");
    const { items } = await gw.runtime.runPromise(GatewayStore.use((s) => s.snapshot(threadId)));
    const answer = items.findLast((i) => i.turnId === turnId && i.item?.content.case === "agentMessage");

    return answer?.item?.content.case === "agentMessage" ? answer.item.content.value.text : "";
  }

  const ask = async (threadId: string) => {
    const turn = (
      await gw.api.sendMessage({ threadId, text: "REPORT_THREAD_CWD", clientRequestId: Bun.randomUUIDv7() })
    ).turn!;

    return JSON.parse(await settledTurn(threadId, turn.id)) as { cwd: string };
  };

  const finished = (id: string) =>
    eventually(
      () => gw.api.getThreadTransfer({ id }),
      (t) => t.state === "done" || t.state === "aborted",
      60_000,
    );

  test("moves the session and every kind of change, and a failed move rolls back", async () => {
    const created = (
      await gw.api.createThread({
        projectId: project.id,
        workspaceId: workspaceA.id,
        provider: Provider.CODEX,
        workspaceMode: ui.WorkspaceMode.NEW_WORKTREE,
        permissionMode: PermissionMode.FULL_AUTO,
        baseRef: "main",
      })
    ).thread!;

    const first = await ask(created.id);
    const source = await thread(created.id);
    expect(first.cwd).toBe(source.cwd!);
    const session = source.provider_thread_id!;

    // A real rollout next to the fixture's own session record, as Codex writes it.
    const codexHome = [a.home, join(a.data, "codex-home")].find((h) =>
      existsSync(join(h, "sessions", `${session}.json`)),
    )!;

    const day = join(codexHome, "sessions", "2026", "11", "28");
    mkdirSync(day, { recursive: true });
    const rollout = `${JSON.stringify({ type: "session_meta", payload: { id: session, cwd: source.cwd, model_provider: "openai" } })}\n`;
    writeFileSync(join(day, `rollout-2026-11-28T10-00-00-${session}.jsonl`), rollout);

    const cwd = source.cwd!;
    const unpushed = commit(cwd, "local.txt", "not pushed\n");
    writeFileSync(join(cwd, "app.txt"), "one\nstaged\n");
    git(cwd, "add", "app.txt");
    writeFileSync(join(cwd, "app.txt"), "one\nstaged\nunstaged\n");
    mkdirSync(join(cwd, "notes"));
    writeFileSync(join(cwd, "notes", "new.md"), "new file\n");
    writeFileSync(join(cwd, ".env"), "TOKEN=local\n");

    const preview = await gw.api.previewThreadTransfer({ threadId: created.id, workerId: b.workerId });
    expect(preview.blocked).toBe("");
    expect(preview.workspaceIds).toEqual(expect.arrayContaining([workspaceB.id, plainB.id]));
    expect(preview.unpushedCommits).toBe(1);
    expect(preview.localFiles.map((f) => [f.path, f.secret])).toEqual([[".env", true]]);
    expect(preview.head).toBe(unpushed);

    const refused = await failure(
      gw.api.startThreadTransfer({
        threadId: created.id,
        workerId: b.workerId,
        workspaceId: workspaceB.id,
        localFiles: [".env"],
        expectedHead: preview.head,
      }),
    );

    expect(refused).toContain("Confirm the local files that can contain secrets");

    // The plain folder on the target is not a repository: the move fails after the freeze and rolls back.
    const failed = await gw.api.startThreadTransfer({
      threadId: created.id,
      workerId: b.workerId,
      workspaceId: plainB.id,
      expectedHead: preview.head,
    });

    const rolledBack = await finished(failed.id);
    expect(rolledBack).toMatchObject({ state: "aborted", error: "The target workspace is not a Git repository." });
    expect(await thread(created.id)).toMatchObject({ worker_id: a.workerId, cwd, transfer_pending_id: null });
    expect((await ask(created.id)).cwd).toBe(cwd);

    const started = await gw.api.startThreadTransfer({
      threadId: created.id,
      workerId: b.workerId,
      workspaceId: workspaceB.id,
      localFiles: [".env"],
      confirmedSecrets: [".env"],
      expectedHead: preview.head,
    });

    const moved = await finished(started.id);
    expect(moved).toMatchObject({ state: "done", error: "" });

    const after = await thread(created.id);
    expect(after).toMatchObject({ worker_id: b.workerId, workspace_id: workspaceB.id, provider_thread_id: session });
    const target = after.cwd!;
    expect(target).not.toBe(cwd);
    expect(git(target, "rev-parse", "HEAD")).toBe(unpushed);
    expect(git(target, "show", ":app.txt")).toBe("one\nstaged");
    expect(readFileSync(join(target, "app.txt"), "utf8")).toBe("one\nstaged\nunstaged\n");
    expect(readFileSync(join(target, "notes", "new.md"), "utf8")).toBe("new file\n");
    expect(readFileSync(join(target, ".env"), "utf8")).toBe("TOKEN=local\n");

    // The rollout is adopted on the target, and the next turn resumes the same Codex thread in the new folder.
    const adopted = [b.home, join(b.data, "codex-home")].some((home) =>
      readdirSync(join(home, "sessions"), { recursive: true }).some((p) => String(p).endsWith(`-${session}.jsonl`)),
    );

    expect(adopted).toBe(true);
    expect((await ask(created.id)).cwd).toBe(target);

    const notices = await sql(
      (q) => q<{ message: string }>`SELECT payload->'notice'->>'message' AS message FROM thread_events
        WHERE thread_id = ${created.id}::uuid AND payload ? 'notice' AND payload->'notice'->>'code' = 'transferred'`,
    );

    expect(notices.map((n) => n.message)).toEqual(["Moved from Laptop to Office"]);
    // The source keeps its checkout as it was.
    expect(readFileSync(join(cwd, ".env"), "utf8")).toBe("TOKEN=local\n");
  }, 180_000);
});
