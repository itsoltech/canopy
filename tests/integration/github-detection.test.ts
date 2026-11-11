import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { create, toJson } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import { ItemStatus, ThreadEventSchema, ui } from "@canopy/contracts";
import { git, commit, worktreeFixture } from "./support/worktrees.ts";
import { connectGitHub } from "./support/github-pr.ts";
import { detectionPull, githubDetectionFixture } from "./support/github-detection.ts";
import { GatewayStore } from "@canopy/gateway/store";
import { GitHubDetection } from "../../apps/gateway/src/github/detection.ts";

describe.skipIf(!dockerAvailable)("GitHub branch discovery through WorkerHost", () => {
  const dir = tempDir("canopy-github-detection-");
  let f: Awaited<ReturnType<typeof worktreeFixture>>;
  const api = githubDetectionFixture();
  let thread: ui.Thread;
  let account = "";
  let detection: GitHubDetection;

  let branch = "",
    head = "";

  const run = async () => {
    await detection.tick();
    await f.sql((sql) => sql`UPDATE github_detection_jobs SET next_at=now() WHERE thread_id=${thread.id}::uuid`);
    await detection.tick();

    return f.gw.core.github.prs.list(thread.id);
  };

  const invalidate = () =>
    f.sql((sql) => sql`DELETE FROM github_pr_cache WHERE cache_key LIKE 'discovery:%' OR cache_key LIKE 'summary:%'`);

  const context = async () => {
    const result = await f.command({
      commandId: crypto.randomUUID(),
      kind: { case: "readGitPrContext", value: { repoPath: thread.cwd, fresh: true } },
    });

    expect(result?.ok).toBe(true);

    return result!.gitPrContext!;
  };

  const refreshCheckout = async () => {
    detection.request(thread.id);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await detection.tick();
  };

  beforeAll(async () => {
    f = await worktreeFixture(dir, { github: api.options, capabilities: ["git_pr_context_v1", "git_heads"] });
    await f.gw.core.githubDetection.stop();
    detection = new GitHubDetection(f.gw.core);
    git(f.repo, "config", `url.${f.origin}.insteadOf`, "https://github.com/itsoltech/canopy.git");
    git(f.repo, "remote", "set-url", "origin", "https://github.com/itsoltech/canopy.git");
    thread = await f.tree();
    branch = git(thread.cwd, "branch", "--show-current");
    head = git(thread.cwd, "rev-parse", "HEAD");
    account = await connectGitHub(f.gw, api);
    await f.gw.api.setGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy", accountId: account });
    await f.gw.core.github.run((s) => s.detectionRequest(f.gw.userId, thread.id));
  }, 60_000);
  afterAll(async () => {
    await detection?.stop();
    await f?.close();
    api.close();
  });

  test("full HEAD, push, changed refs, open/merged and a stack sharing one head", async () => {
    expect(await context()).toMatchObject({ headOid: head, branch, pushRef: branch, pushRemote: "origin" });
    api.pulls.set(42, detectionPull(42, branch, head));
    api.pulls.set(43, detectionPull(43, branch, head, { state: "merged", baseRef: "next" }));
    api.pulls.set(44, detectionPull(44, "other-stack-head", head));
    let links = (await run()).links;
    expect(links.map((l) => l.summary?.ref?.number).sort()).toEqual([42, 43]);
    expect(links.map((l) => ({ source: l.source, current: l.currentBranch }))).toEqual([
      { source: "auto", current: true },
      { source: "auto", current: true },
    ]);
    const newHead = commit(thread.cwd, "new.txt");
    git(thread.cwd, "push", "-qu", "origin", branch);
    api.pulls.set(45, detectionPull(45, branch, newHead));
    await refreshCheckout();
    links = (await run()).links;
    expect(links.some((l) => l.summary?.ref?.number === 45)).toBe(true);
    expect(await context()).toMatchObject({ headOid: newHead, upstreamRef: branch });
    // Unpublished local descendants accept open PRs, but do not acquire an old closed PR.
    api.pulls.set(46, detectionPull(46, branch, head, { state: "closed" }));
    await invalidate();
    expect((await run()).links.some((l) => l.summary?.ref?.number === 46)).toBe(false);
    head = newHead;
  });

  test("unlink tombstone survives replay and manual Link explicitly restores it", async () => {
    const current = await run();
    const pr = current.links.find((l) => l.summary?.ref?.number === 42)!.summary!.ref!;
    await f.gw.api.unlinkThreadPullRequest({
      threadId: thread.id,
      pullRequestId: pr.id,
      expectedRevision: current.revision,
    });
    expect((await run()).links.some((l) => l.summary?.ref?.number === 42)).toBe(false);
    await f.restart();
    expect((await run()).links.some((l) => l.summary?.ref?.number === 42)).toBe(false);
    const list = await f.gw.core.github.prs.list(thread.id);

    const restored = await f.gw.api.linkThreadPullRequest({
      threadId: thread.id,
      url: "https://github.com/itsoltech/canopy/pull/42",
      expectedRevision: list.revision,
    });

    expect(restored.links.find((l) => l.summary?.ref?.number === 42)?.source).toBe("manual");
    expect((await run()).links.find((l) => l.summary?.ref?.number === 42)?.source).toBe("manual");
  });

  test("fork push target differs from upstream, tracking ref differs from local branch", async () => {
    git(thread.cwd, "remote", "add", "upstream", "https://github.com/itsoltech/canopy.git");
    git(thread.cwd, "remote", "set-url", "--push", "origin", "git@github.com:fork-owner/canopy.git");
    git(thread.cwd, "config", `remote.origin.push`, `refs/heads/${branch}:refs/heads/published-feature`);
    api.pulls.set(47, detectionPull(47, "published-feature", head, { headId: 888, headName: "fork-owner/canopy" }));
    api.pulls.set(48, detectionPull(48, "published-feature", head));
    await refreshCheckout();
    const links = (await run()).links;
    expect(links.find((l) => l.summary?.ref?.number === 47)).toMatchObject({ source: "auto", currentBranch: true });
    expect(links.some((l) => l.summary?.ref?.number === 48)).toBe(false);
    expect(api.requests.some((r) => new URLSearchParams(r).get("head") === "fork-owner:published-feature")).toBe(true);
  });

  test("branch switch retains history; detached and ambiguous push targets cannot auto-link", async () => {
    git(thread.cwd, "checkout", "-qb", "reuse");
    await refreshCheckout();
    expect((await run()).links.every((l) => !l.currentBranch)).toBe(true);
    git(thread.cwd, "checkout", "--detach", "-q", head);
    api.pulls.set(49, detectionPull(49, "published-feature", head, { headId: 888, headName: "fork-owner/canopy" }));
    await invalidate();
    await refreshCheckout();
    expect((await run()).links.some((l) => l.summary?.ref?.number === 49)).toBe(false);
    expect((await context()).branch).toBe("");
    git(thread.cwd, "checkout", "-q", branch);
    git(thread.cwd, "remote", "set-url", "--add", "--push", "origin", "https://github.com/another/fork.git");
    await refreshCheckout();
    expect((await run()).links.some((l) => l.summary?.ref?.number === 49)).toBe(false);
  });

  test("completed tool output can link a different stack head; arbitrary URLs and tombstones fail", async () => {
    git(thread.cwd, "config", "--unset-all", "remote.origin.pushurl");
    git(thread.cwd, "config", "--unset-all", "remote.origin.push");
    await refreshCheckout();
    api.pulls.set(50, detectionPull(50, "stack-created-by-agent", head));

    const event = create(ThreadEventSchema, {
      threadId: thread.id,
      eventId: crypto.randomUUID(),
      occurredAt: timestampNow(),
      body: {
        case: "itemCompleted",
        value: {
          item: {
            itemId: "created-pr",
            status: ItemStatus.COMPLETED,
            content: {
              case: "commandExecution",
              value: {
                command: "gh pr create",
                exitCode: 0,
                output:
                  "https://github.com/itsoltech/canopy/pull/50\nhttps://github.com/itsoltech/canopy/pull/49?token=ignored\nhttps://github.com.evil.test/itsoltech/canopy/pull/51",
              },
            },
          },
        },
      },
    });

    await f.sql(
      (sql) => sql`INSERT INTO thread_events(thread_id,seq,event_id,origin,kind,item_id,payload,occurred_at)
      SELECT ${thread.id}::uuid,coalesce(max(seq),0)+1,${event.eventId}::uuid,'worker','item_completed','created-pr',${JSON.stringify(toJson(ThreadEventSchema, event))}::jsonb,now()
      FROM thread_events WHERE thread_id=${thread.id}::uuid`,
    );
    const linked = await run();
    expect((await f.gw.core.github.run((s) => s.detectionDetail(f.gw.userId, thread.id)))[0]?.detail).toBe("");
    expect(linked.links.find((l) => l.summary?.ref?.number === 50)).toMatchObject({
      source: "auto",
      evidence: "tool_output",
    });
    expect((await run()).links.filter((l) => l.summary?.ref?.number === 50)).toHaveLength(1);
  });

  test("owner scoping and background budget/backoff prevent requests", async () => {
    const other = await f.gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("other-detection@x", "Other")));
    await expect(f.gw.core.github.run((s) => s.prList(other, thread.id))).rejects.toThrow();
    await f.sql((sql) => sql`UPDATE github_api_budgets SET remaining=900,limit_count=5000 WHERE resource='core'`);
    await invalidate();
    let before = api.requests.length;
    await run();
    expect(api.requests.length).toBe(before);
    await f.sql((sql) => sql`UPDATE github_api_budgets SET remaining=5000 WHERE resource='core'`);
    api.limit(true);
    await run();
    before = api.requests.length;
    await run();
    expect(api.requests.length).toBe(before);
    api.limit(false);
  });
});
