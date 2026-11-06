/**
 * The live branch of thread checkouts (docs/worktrees.md, "Bieżąca gałąź"): a real WorkerHost watches each
 * thread's git HEAD and reports changes over gRPC; the gateway stores and broadcasts them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { eventually, watchUntil } from "./support/gateway.ts";
import { git, worktreeFixture } from "./support/worktrees.ts";

describe.skipIf(!dockerAvailable)("live git heads over the worker link", () => {
  const dir = tempDir("canopy-git-heads-");
  let f: Awaited<ReturnType<typeof worktreeFixture>>;

  beforeAll(async () => {
    f = await worktreeFixture(dir, { capabilities: ["git_heads"] });
  }, 60_000);

  afterAll(async () => {
    await f?.close();
  });

  const thread = (threadId: string) => f.gw.api.getThread({ threadId }).then((r) => r.thread!);

  test("a branch the agent creates in the worktree replaces the shown one live; the base stays", async () => {
    const created = await f.tree();
    const first = created.worktree!.branch;

    const updates = watchUntil(f.gw.api, created.id, (u) =>
      u.some((x) => x.change.case === "thread" && x.change.value.worktree?.branch === "feature/agent-email-channel"),
    );

    git(created.cwd, "switch", "-q", "-c", "feature/agent-email-channel");
    expect((await updates).length).toBeGreaterThan(0);
    const shown = await thread(created.id);
    expect(shown.worktree).toMatchObject({
      branch: "feature/agent-email-channel",
      baseRef: "main",
      detachedCommit: "",
    });
    // Scan and status follow the branch the worktree is really on.
    expect((await f.entry(created.worktree!.id)).status?.branch).toBe("feature/agent-email-channel");

    // A detached HEAD shows its commit; switching back shows the branch again.
    const head = git(created.cwd, "rev-parse", "--short", "HEAD");
    git(created.cwd, "switch", "-q", "--detach");

    const detached = await eventually(
      () => thread(created.id),
      (t) => t.worktree?.detachedCommit === head,
    );

    // The record keeps the last branch; the UI shows the detached commit.
    expect(detached.worktree?.branch).toBe("feature/agent-email-channel");
    await Bun.sleep(1_100); // git reads are cached for a second
    expect((await f.entry(created.worktree!.id)).status?.detail ?? "").toBe("");
    git(created.cwd, "switch", "-q", first);
    expect(
      (
        await eventually(
          () => thread(created.id),
          (t) => t.worktree?.branch === first,
        )
      ).worktree?.branch,
    ).toBe(first);
  }, 30_000);

  test("a thread in the workspace checkout shows the checkout's branch; reconnecting catches up", async () => {
    const checkout = (
      await f.gw.api.createThread({
        projectId: f.project.id,
        workspaceId: f.workspace.id,
        provider: Provider.CODEX,
        initialMessage: "Work in the checkout",
      })
    ).thread!;

    expect(checkout.worktree).toBeUndefined();
    await eventually(
      () => thread(checkout.id),
      (t) => t.checkoutHead?.branch === "main",
    );

    // Changed while the link is down: the worker sends its full state after the next connection.
    f.disconnect();
    git(f.repo, "switch", "-q", "-c", "release/next");
    await Bun.sleep(400);
    await f.connect();
    expect(
      (
        await eventually(
          () => thread(checkout.id),
          (t) => t.checkoutHead?.branch === "release/next",
        )
      ).checkoutHead,
    ).toMatchObject({ branch: "release/next", detachedCommit: "" });
    git(f.repo, "switch", "-q", "main");
    await eventually(
      () => thread(checkout.id),
      (t) => t.checkoutHead?.branch === "main",
    );
  }, 30_000);

  test("reports for threads of another worker, or with a bad branch, change nothing", async () => {
    const created = await f.tree();
    const other = await f.gw.addWorker("Other");

    // The gateway accepts heads only for the reporting worker's threads.
    const foreign = await f.gw.runtime.runPromise(
      GatewayStore.use((s) => s.saveGitHead(other.workerId, [created.id], { branch: "stolen", detachedCommit: "" })),
    );

    expect(foreign).toEqual([]);

    f.send({ case: "gitHeads", value: { heads: [{ threadIds: [created.id], branch: "bad\nname" }] } });
    f.send({ case: "gitHeads", value: { heads: [{ threadIds: [created.id], detachedCommit: "not-a-commit" }] } });
    await Bun.sleep(300);
    expect((await thread(created.id)).worktree?.branch).toBe(created.worktree!.branch);
  });
});
