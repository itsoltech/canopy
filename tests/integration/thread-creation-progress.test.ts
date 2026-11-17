import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { nodeRef } from "@canopy/domain/computers";
import { worktreeFixture, git } from "./support/worktrees.ts";
import { eventually } from "./support/gateway.ts";
import { linkedProjectFixture } from "./support/linked-projects.ts";

describe.skipIf(!dockerAvailable)("thread preparation progress through real worker links", () => {
  const dir = tempDir("canopy-thread-progress-");
  let f: Awaited<ReturnType<typeof worktreeFixture>>;
  let older: Awaited<ReturnType<typeof worktreeFixture>>;

  beforeAll(async () => {
    mkdirSync(join(dir, "new"));
    mkdirSync(join(dir, "old"));
    f = await worktreeFixture(join(dir, "new"), { capabilities: ["worktree_progress_v1"] });
    older = await worktreeFixture(join(dir, "old"));
  }, 60_000);

  afterAll(async () => {
    await older?.close();
    await f?.close();
  }, 30_000);

  const request = () => ({
    projectId: f.project.id,
    workspaceId: f.workspace.id,
    provider: Provider.CODEX,
    workspaceMode: ui.WorkspaceMode.NEW_WORKTREE,
    baseRef: "main",
    clientRequestId: Bun.randomUUIDv7(),
  });

  test("real fetch and checkout events precede the final immutable thread; retries reuse it", async () => {
    await f.settings({ startFromRemote: true });
    const input = request();
    const events = await Array.fromAsync(f.gw.api.createThreadWithProgress(input));
    expect(events).toContainEqual(
      expect.objectContaining({ step: "fetch_remote", status: "running", label: "Fetch remote branch" }),
    );
    expect(events).toContainEqual(expect.objectContaining({ step: "fetch_remote", status: "completed" }));
    expect(events).toContainEqual(expect.objectContaining({ step: "create_worktree", status: "running" }));
    const final = events.at(-1)!;
    expect(final).toMatchObject({ step: "start_thread", status: "completed" });
    const thread = final.thread!;
    expect(thread.worktree?.path).toBe(thread.cwd);
    expect(thread.cwd).not.toBe(f.repo);
    expect(git(f.repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(events.slice(0, -1).every((event) => !event.thread)).toBe(true);
    await f.settled(thread);
    const retried = await Array.fromAsync(f.gw.api.createThreadWithProgress(input));
    expect(retried.at(-1)?.thread?.id).toBe(thread.id);
    expect(retried).toContainEqual(expect.objectContaining({ step: "create_worktree", status: "skipped" }));
  }, 20_000);

  test("checkout skips Git creation, invalid bases fail without creating a thread", async () => {
    const checked = await Array.fromAsync(
      f.gw.api.createThreadWithProgress({ ...request(), workspaceMode: ui.WorkspaceMode.CHECKOUT }),
    );

    expect(checked).toContainEqual(expect.objectContaining({ step: "create_worktree", status: "skipped" }));
    await f.settled(checked.at(-1)!.thread!);
    const before = await f.gw.api.listThreads({ projectId: f.project.id });
    const failed = await Array.fromAsync(f.gw.api.createThreadWithProgress({ ...request(), baseRef: "missing-base" }));
    expect(failed.at(-1)).toMatchObject({ step: "check_workspace", status: "failed" });
    expect(failed.at(-1)?.detail).toContain("not a branch or commit");
    expect(failed.some((event) => event.thread)).toBe(false);
    expect((await f.gw.api.listThreads({ projectId: f.project.id })).threads.length).toBe(before.threads.length);
  }, 20_000);

  test("fetch failure reports a local fallback and older workers only report broad creation", async () => {
    git(f.repo, "remote", "set-url", "origin", join(dir, "missing.git"));

    try {
      const events = await Array.fromAsync(f.gw.api.createThreadWithProgress(request()));
      expect(events).toContainEqual(
        expect.objectContaining({
          step: "fetch_remote",
          status: "skipped",
          detail: "Fetch failed. Using the local base.",
        }),
      );
      await f.settled(events.at(-1)!.thread!);
    } finally {
      git(f.repo, "remote", "set-url", "origin", f.origin);
    }

    const legacy = await Array.fromAsync(
      older.gw.api.createThreadWithProgress({
        ...request(),
        projectId: older.project.id,
        workspaceId: older.workspace.id,
      }),
    );

    expect(legacy).toContainEqual(expect.objectContaining({ step: "create_worktree", status: "running" }));
    expect(legacy.some((event) => event.step === "fetch_remote")).toBe(false);
    await older.settled(legacy.at(-1)!.thread!);
  }, 20_000);

  test("draft delivery settles before completion and keeps worktree failure attribution", async () => {
    const input = { ...request(), draftId: Bun.randomUUIDv7(), draftRevision: 0n };
    const events = await Array.fromAsync(f.gw.api.createThreadWithProgress(input));
    const thread = events.at(-1)!.thread!;
    expect(thread).toBeDefined();

    const delivery = await f.gw.api.getComposerDraftDelivery({
      id: input.draftId,
      clientRequestId: input.clientRequestId,
      workspaceId: f.workspace.id,
    });

    expect(delivery.confirmed).toBe(true);
    await f.settled(thread);

    const failed = await Array.fromAsync(
      f.gw.api.createThreadWithProgress({ ...request(), draftId: Bun.randomUUIDv7(), baseRef: "draft-missing-base" }),
    );

    expect(failed.at(-1)).toMatchObject({ step: "check_workspace", status: "failed" });
    expect(failed.at(-1)?.detail).toContain("not a branch or commit");
    expect(failed.some((event) => event.thread)).toBe(false);
  }, 20_000);

  test("another owner's workspace never admits creation", async () => {
    const events = await Array.fromAsync(
      f.gw.api.createThreadWithProgress({ ...request(), projectId: older.project.id, workspaceId: older.workspace.id }),
    );

    expect(events.at(-1)?.status).toBe("failed");
    expect(events.some((event) => event.thread)).toBe(false);
  });

  test("stream cancellation preserves the admitted creation for a retry", async () => {
    const input = { ...request(), title: "Canceled creation" };
    const controller = new AbortController();
    const events = f.gw.api.createThreadWithProgress(input, { signal: controller.signal });

    for await (const event of events) {
      if (event.step === "create_worktree" && event.status === "running") {
        controller.abort();
        break;
      }
    }

    // Wait for the detached creation rather than race another workspace allocation.
    const found = await eventually(
      () => f.gw.api.listThreads({ projectId: f.project.id }),
      (result) => result.threads.some((thread) => thread.title === input.title),
    );

    const thread = found.threads.find((thread) => thread.title === input.title)!;
    await f.settled(thread);
    const retried = await Array.fromAsync(f.gw.api.createThreadWithProgress(input));
    expect(retried.at(-1)?.thread?.id).toBe(thread.id);
  }, 20_000);
});

describe.skipIf(!dockerAvailable)("linked thread creation progress", () => {
  const dir = tempDir("canopy-linked-thread-progress-");
  let f: Awaited<ReturnType<typeof linkedProjectFixture>>;
  beforeAll(async () => {
    f = await linkedProjectFixture(dir, { shared: true, worktreeProgress: true });
    git(f.b.repo, "remote", "set-url", "origin", f.b.origin);
  }, 90_000);
  afterAll(async () => {
    await f?.close();
  }, 30_000);

  test("routes to the workspace home, qualifies final ids, and falls back for an older home", async () => {
    const suffix = `~${nodeRef(f.lb.hello().nodeId)}`;
    const local = await f.a.gw.api.getOverview({});

    const workspace = local.projects
      .flatMap((project) => project.workspaces)
      .find((ws) => ws.workerId === `${f.b.workerId}${suffix}`)!;

    const input = {
      projectId: workspace.projectId,
      workspaceId: workspace.id,
      provider: Provider.CODEX,
      workspaceMode: ui.WorkspaceMode.CHECKOUT,
      clientRequestId: Bun.randomUUIDv7(),
    };

    const events = await Array.fromAsync(f.a.gw.api.createThreadWithProgress(input));
    const thread = events.at(-1)!.thread!;
    expect(thread.id.endsWith(suffix)).toBe(true);
    expect(thread.workerId).toBe(`${f.b.workerId}${suffix}`);
    expect(thread.cwd).toBe(f.b.repo);
    await f.b.settled((await f.b.gw.api.getThread({ threadId: thread.id.slice(0, -suffix.length) })).thread!);
    await f.b.settings({ startFromRemote: true });

    const worktree = await Array.fromAsync(
      f.a.gw.api.createThreadWithProgress({
        ...input,
        workspaceMode: ui.WorkspaceMode.NEW_WORKTREE,
        baseRef: "main",
        clientRequestId: Bun.randomUUIDv7(),
      }),
    );

    expect(worktree).toContainEqual(expect.objectContaining({ step: "fetch_remote", status: "completed" }));
    const created = worktree.at(-1)!.thread!;
    expect(created.worktree?.id.endsWith(suffix)).toBe(true);
    expect(created.worktree?.path).toBe(created.cwd);
    expect(created.cwd).not.toBe(f.b.repo);
    await f.b.settled((await f.b.gw.api.getThread({ threadId: created.id.slice(0, -suffix.length) })).thread!);
    const capabilities = f.la.capabilities.bind(f.la);
    f.la.capabilities = (node) =>
      capabilities(node).filter((capability) => capability !== "thread_creation_progress_v1");

    try {
      const older = await Array.fromAsync(
        f.a.gw.api.createThreadWithProgress({ ...input, clientRequestId: Bun.randomUUIDv7() }),
      );

      expect(older.map((event) => `${event.step}:${event.status}`)).toEqual([
        "start_thread:running",
        "start_thread:completed",
      ]);
      expect(older.at(-1)!.thread!.id.endsWith(suffix)).toBe(true);
      await f.b.settled(
        (await f.b.gw.api.getThread({ threadId: older.at(-1)!.thread!.id.slice(0, -suffix.length) })).thread!,
      );
    } finally {
      f.la.capabilities = capabilities;
    }
  }, 30_000);
});
