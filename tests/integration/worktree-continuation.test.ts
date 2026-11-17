import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { PermissionMode, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { Effect } from "effect";
import { failure } from "./support/gateway.ts";
import { commit, git, worktreeFixture } from "./support/worktrees.ts";

/** Real PostgreSQL, Git and WorkerHost: a fresh provider session sees a seed before its creation. */
describe.skipIf(!dockerAvailable)("continue a removed worktree over gRPC", () => {
  const dir = tempDir("canopy-worktree-continuation-");
  let f: Awaited<ReturnType<typeof worktreeFixture>>;
  beforeAll(async () => {
    f = await worktreeFixture(dir, { codexFixture: new URL("./fixtures/continuation-codex.ts", import.meta.url) });
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });

  const resume = (threadId: string, baseRef = "main", clientRequestId = Bun.randomUUIDv7()) =>
    f.gw.api.continueThreadInWorktree({ threadId, baseRef, clientRequestId });

  async function message(thread: ui.Thread, ordinal: number, text: string) {
    const id = Bun.randomUUIDv7();
    const seq = ordinal * 2;
    await f.sql(
      (sql) => sql`INSERT INTO turns(id,thread_id,ordinal,status,trigger,author_user_id,input,
      first_seq,last_seq,provider_turn_ref,completed_at)
      VALUES(${id}::uuid,${thread.id}::uuid,${ordinal},'completed','user',${f.gw.userId}::uuid,
        ${JSON.stringify({ text })}::jsonb,${seq},${seq + 1},${`provider-${ordinal}`},now())`,
    );
    await f.sql(
      (sql) => sql`INSERT INTO thread_items(thread_id,item_id,turn_id,type,status,content,first_seq,last_seq)
      VALUES(${thread.id}::uuid,${`answer-${ordinal}`},${id}::uuid,'agent_message','completed',
        ${JSON.stringify({ agentMessage: { text: `Answer: ${text}` } })}::jsonb,${seq + 1},${seq + 1}),
      (${thread.id}::uuid,${`tool-${ordinal}`},${id}::uuid,'tool_call','completed',
        '{"toolCall":{"output":"PRIVATE_TOOL_PAYLOAD"}}'::jsonb,${seq},${seq})`,
    );
    await f.sql((sql) => sql`UPDATE threads SET last_seq=greatest(last_seq,${seq + 1}) WHERE id=${thread.id}::uuid`);

    return id;
  }

  test("archived history stays put; simultaneous retries create one checkout and seeded session", async () => {
    const source = await f.tree();
    const selectedCommit = commit(source.cwd, "committed.txt", "committed source work");
    writeFileSync(join(source.cwd, "uncommitted.txt"), "must not be recreated");
    await message(source, 1, "Keep the selected implementation and review it");
    await f.sql(
      (sql) => sql`UPDATE threads SET settings=settings || '{"model":"custom-recovery-model",
      "effort":"high","instructions":"Keep the original project conventions.","permissionMode":"FULL_ACCESS",
      "permissionModeNote":"old escalation","branchNote":"obsolete branch instruction"}'::jsonb
      WHERE id=${source.id}::uuid`,
    );
    expect((await f.remove(source.worktree!.id, true)).removed).toBe(true);
    expect(
      await failure(
        f.gw.api.sendMessage({ threadId: source.id, text: "Old location", clientRequestId: Bun.randomUUIDv7() }),
      ),
    ).toContain("worktree");
    await f.gw.api.setThreadArchived({ threadId: source.id, archived: true });
    const requestId = Bun.randomUUIDv7();
    const before = git(f.repo, "worktree", "list", "--porcelain");

    const [one, two] = await Promise.all([
      resume(source.id, source.worktree!.branch, requestId),
      resume(source.id, source.worktree!.branch, requestId),
    ]);

    const continued = one.thread!;
    expect(two.thread!.id).toBe(continued.id);
    await f.settled(continued);
    expect(continued).toMatchObject({
      kind: ui.ThreadKind.MAIN,
      parentThreadId: "",
      projectId: source.projectId,
      workspaceId: source.workspaceId,
      workerId: source.workerId,
      provider: source.provider,
      providerProfileId: source.providerProfileId,
      model: "custom-recovery-model",
      effort: "high",
      permissionMode: PermissionMode.FULL_AUTO,
      permissionModeNote: "",
    });
    expect(continued.cwd).not.toBe(source.cwd);
    expect(continued.worktree!.id).not.toBe(source.worktree!.id);
    expect(git(continued.cwd, "rev-parse", "HEAD")).toBe(selectedCommit);
    expect(readFileSync(join(continued.cwd, "committed.txt"), "utf8")).toBe("committed source work");
    expect(existsSync(join(continued.cwd, "uncommitted.txt"))).toBe(false);
    expect(existsSync(source.cwd)).toBe(false);
    const instructions = readFileSync(join(continued.cwd, "harness-instructions.txt"), "utf8");
    expect(instructions).toContain("Keep the original project conventions.");
    expect(instructions).toContain(source.id);
    expect(instructions).toContain(`/threads/${source.id}`);
    expect(instructions).toContain(source.cwd);
    expect(instructions).toContain("have not been restored");
    expect(instructions).toContain("Old file paths are obsolete");
    expect(instructions).toContain("User: Keep the selected implementation");
    expect(instructions).toContain("Assistant: Answer: Keep the selected implementation");
    expect(instructions).not.toContain("PRIVATE_TOOL_PAYLOAD");
    expect(instructions).not.toContain("obsolete branch instruction");
    expect(instructions).not.toContain("old escalation");
    const old = (await f.gw.api.getThread({ threadId: source.id })).thread!;
    expect(old.archivedAt).toBeDefined();
    expect(old.cwd).toBe(source.cwd);
    expect(old.worktree!.id).toBe(source.worktree!.id);

    const rows = await f.sql(
      (sql) => sql<{ commands: number; turns: number }>`SELECT
      (SELECT count(*)::int FROM worker_commands WHERE thread_id=${continued.id}::uuid AND kind='createThread') AS commands,
      (SELECT count(*)::int FROM turns WHERE thread_id=${continued.id}::uuid) AS turns`,
    );

    expect(rows[0]).toEqual({ commands: 1, turns: 0 });
    expect((await resume(source.id, "main", requestId)).thread!.id).toBe(continued.id);
    expect(git(f.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)!.length).toBe(
      before.match(/^worktree /gm)!.length + 1,
    );
  });

  test("inherited history stops at the fork point and the continuation uses a fresh session", async () => {
    const ancestor = await f.tree();
    const first = await message(ancestor, 1, "Inherited visible instruction");
    await message(ancestor, 2, "Beyond the fork point");

    const fork = await f.gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.createThread(
          f.gw.userId,
          create(ui.CreateThreadRequestSchema, {
            projectId: f.project.id,
            workspaceId: f.workspace.id,
            provider: Provider.CODEX,
            workspaceMode: ui.WorkspaceMode.EXISTING_WORKTREE,
            worktreeId: ancestor.worktree!.id,
            forkThreadId: ancestor.id,
            forkAtTurnId: first,
            title: "Saved fork",
          }),
        ),
      ),
    );

    await f.gw.runtime.runPromise(GatewayStore.use((s) => s.setThreadStatus(fork.id, "idle", null)));
    await f.remove(ancestor.worktree!.id, true);
    const continued = (await resume(fork.id)).thread!;
    await f.settled(continued);
    const instructions = readFileSync(join(continued.cwd, "harness-instructions.txt"), "utf8");
    expect(instructions).toContain("Inherited visible instruction");
    expect(instructions).not.toContain("Beyond the fork point");
    const stored = await f.gw.runtime.runPromise(GatewayStore.use((s) => s.thread(continued.id)));
    expect(stored.fork_source_thread_id).toBeNull();
    expect(stored.fork_after_turn_id).toBeNull();
    expect(stored.provider_thread_id).toBeTruthy();
  });

  test("live, removal-in-progress and deleted sources cannot create a checkout", async () => {
    const live = await f.tree();
    const before = git(f.repo, "worktree", "list", "--porcelain");
    expect(await failure(resume(live.id))).toContain("removed managed worktree");
    await f.sql(
      (sql) => sql`UPDATE worktrees SET removal_token=${Bun.randomUUIDv7()}::uuid,removal_started_at=now()
      WHERE id=${live.worktree!.id}::uuid`,
    );
    expect(await failure(resume(live.id))).toContain("removed managed worktree");
    await f.sql(
      (sql) => sql`UPDATE worktrees SET removal_token=NULL,removal_started_at=NULL WHERE id=${live.worktree!.id}::uuid`,
    );
    expect(git(f.repo, "worktree", "list", "--porcelain")).toBe(before);
    await f.remove(live.worktree!.id, true);
    await f.gw.api.deleteThread({ threadId: live.id });
    expect(await failure(resume(live.id))).toContain("thread");
  });

  test("external worktrees and regular checkouts cannot be continued through recovery", async () => {
    const path = join(f.dir, "external-worktree");
    git(f.repo, "worktree", "add", "-b", "outside", path, "main");

    const external = await f.gw.runtime.runPromise(
      GatewayStore.use((s) =>
        Effect.gen(function* () {
          const worktree = yield* s.insertWorktree({
            id: Bun.randomUUIDv7(),
            owner_user_id: f.gw.userId,
            project_id: f.project.id,
            workspace_id: f.workspace.id,
            worker_id: f.workerId,
            repo_root: f.repo,
            path,
            branch: "outside",
            base_ref: "",
            base_commit: git(path, "rev-parse", "HEAD"),
            external: true,
          });

          return yield* s.createThread(
            f.gw.userId,
            create(ui.CreateThreadRequestSchema, {
              projectId: f.project.id,
              workspaceId: f.workspace.id,
              provider: Provider.CODEX,
              workspaceMode: ui.WorkspaceMode.EXISTING_WORKTREE,
              worktreeId: worktree.id,
            }),
          );
        }),
      ),
    );

    const before = git(f.repo, "worktree", "list", "--porcelain");
    expect(await failure(resume(external.id))).toContain("removed managed worktree");

    const checkout = (
      await f.gw.api.createThread({
        projectId: f.project.id,
        workspaceId: f.workspace.id,
        provider: Provider.CODEX,
        workspaceMode: ui.WorkspaceMode.CHECKOUT,
      })
    ).thread!;

    await f.settled(checkout);
    expect(await failure(resume(checkout.id))).toContain("no removed managed worktree");
    expect(git(f.repo, "worktree", "list", "--porcelain")).toBe(before);
  });

  test("foreign threads are rejected before looking up their workspace or history", async () => {
    const foreign = await f.gw.runtime.runPromise(
      GatewayStore.use((s) =>
        Effect.gen(function* () {
          const user = yield* s.ensureUser("continuation-other@example.test", "Other");
          const project = yield* s.createProject(user, "Private");
          const worker = yield* s.addWorker({ name: "Private worker", ownerUserId: user });

          const workspace = yield* s.createWorkspace({
            projectId: project.id,
            workerId: worker.workerId,
            rootPath: f.repo,
            label: "",
          });

          return yield* s.createThread(
            user,
            create(ui.CreateThreadRequestSchema, {
              projectId: project.id,
              workspaceId: workspace.id,
              provider: Provider.CODEX,
              workspaceMode: ui.WorkspaceMode.CHECKOUT,
            }),
          );
        }),
      ),
    );

    const before = git(f.repo, "worktree", "list", "--porcelain");
    expect(await failure(resume(foreign.id))).toContain("Thread not found");
    expect(git(f.repo, "worktree", "list", "--porcelain")).toBe(before);
  });
});
