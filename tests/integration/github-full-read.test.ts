import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { Code, ConnectError } from "@connectrpc/connect";
import { GitHubAccounts } from "../../apps/gateway/src/github/service.ts";
import { readScope } from "../../apps/gateway/src/github/read-scope.ts";
import { timeline } from "../../apps/gateway/src/github/timeline-query.ts";
import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";
import { linkedRead, readFixture, readHead, readBase } from "./support/github-read.ts";

describe.skipIf(!dockerAvailable)("paginated GitHub read RPCs", () => {
  const fixture = readFixture();
  let gw: TestGateway;
  let pr: string;

  beforeAll(async () => {
    gw = await startTestGateway({ github: fixture.options });
    ({ pr } = await linkedRead(gw, fixture));
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
    fixture.close();
  });

  test("reads more than 100 timeline events in either direction with collection filters", async () => {
    const ids: string[] = [];
    let cursor = "";

    do {
      const result = await gw.api.listPullRequestTimeline({ pullRequestId: pr, cursor });
      expect(result.page?.headSha).toBe(readHead);
      ids.push(...result.items.map((i) => i.content.value!.id));
      cursor = result.page?.nextCursor ?? "";
    } while (cursor);

    expect(ids).toHaveLength(153);
    expect(new Set(ids).size).toBe(153);
    const first = await gw.api.listPullRequestTimeline({ pullRequestId: pr, oldestFirst: true });
    expect(first.items[0]!.content.value!.id).toBe("EVENT_0");

    const authors = await gw.api.listPullRequestTimeline({
      pullRequestId: pr,
      kind: "comment",
      author: "fixture-reviewer",
    });

    expect(authors.items.every((i) => i.content.case === "comment")).toBe(true);
    expect(authors.page?.completeness).toBe("partial");
    expect(
      ConnectError.from(
        await gw.api.listPullRequestTimeline({ pullRequestId: pr, cursor: authors.page!.nextCursor }).catch((e) => e),
      ).code,
    ).toBe(Code.FailedPrecondition);
  });

  test("paginates 137 checks, 113 review threads, 127 replies and 123 jobs independently", async () => {
    let cursor = "";
    let total = 0;

    do {
      const page = await gw.api.listPullRequestChecks({ pullRequestId: pr, cursor });
      total += page.checks.length;
      expect(page.checks.every((c) => c.runId === "123" && c.headSha === readHead)).toBe(true);
      cursor = page.page?.nextCursor ?? "";
    } while (cursor);

    expect(total).toBe(137);
    total = 0;
    cursor = "";

    do {
      const page = await gw.api.listPullRequestReviewThreads({ pullRequestId: pr, cursor });
      total += page.threads.length;
      cursor = page.page?.nextCursor ?? "";
    } while (cursor);

    expect(total).toBe(113);
    const reviews = await gw.api.listPullRequestReviewThreads({ pullRequestId: pr });
    total = reviews.threads[0]!.comments.length;
    cursor = reviews.threads[0]!.repliesCursor;

    do {
      const page = await gw.api.listPullRequestReviewThreads({ pullRequestId: pr, resourceId: "THREAD_0", cursor });
      total += page.threads[0]!.comments.length;
      cursor = page.threads[0]!.repliesCursor;
    } while (cursor);

    expect(total).toBe(127);
    total = 0;
    cursor = "";

    do {
      const page = await gw.api.listPullRequestCheckJobs({ pullRequestId: pr, resourceId: "123", cursor });
      total += page.jobs.length;
      cursor = page.page?.nextCursor ?? "";
    } while (cursor);

    expect(total).toBe(123);
  });

  test("deduplicates several independent clients, preserves partial results and survives restart", async () => {
    const other = new GitHubAccounts(gw.runtime, gw.userId, fixture.options);
    const before = fixture.counts.get("CanopyTimeline") ?? 0;
    const request = create(github.PullRequestPageRequestSchema, { pullRequestId: pr, kind: "commit", refresh: true });

    try {
      await Promise.all([
        gw.api.listPullRequestTimeline(request),
        gw.api.listPullRequestTimeline(request),
        timeline(await readScope(other.prs, request, "timeline")),
      ]);
      expect((fixture.counts.get("CanopyTimeline") ?? 0) - before).toBe(1);
      fixture.partial(true);
      const partial = await gw.api.listPullRequestTimeline({ pullRequestId: pr, refresh: true });
      expect(partial.items).toHaveLength(50);
      expect(partial.page?.completeness).toBe("partial");
      fixture.partial(false);
      await other.stop();
      const restarted = new GitHubAccounts(gw.runtime, gw.userId, fixture.options);

      const cached = await timeline(
        await readScope(restarted.prs, create(github.PullRequestPageRequestSchema, { pullRequestId: pr }), "timeline"),
      );

      expect(cached.items).toHaveLength(50);
      await restarted.stop();
    } finally {
      await other.stop();
      fixture.partial(false);
    }
  });

  test("handles REST 304, 429 stale pages and 403 invalidation without retrying denied content", async () => {
    const first = await gw.api.listPullRequestCommits({ pullRequestId: pr });
    const key = "/repos/itsoltech/canopy/pulls/42/commits";
    const before = fixture.counts.get(key) ?? 0;
    const second = await gw.api.listPullRequestCommits({ pullRequestId: pr, refresh: true });
    expect(second.commits).toEqual(first.commits);
    expect((fixture.counts.get(key) ?? 0) - before).toBe(1);
    fixture.status(429);
    const stale = await gw.api.listPullRequestTimeline({ pullRequestId: pr, refresh: true });
    expect(stale.page?.stale).toBe(true);
    expect(stale.items).toHaveLength(50);
    fixture.status(200);
    fixture.advance(100_000);
    fixture.status(403);
    const denied = await gw.api.listPullRequestTimeline({ pullRequestId: pr, refresh: true }).catch((e) => e);
    expect(ConnectError.from(denied).code).toBe(Code.PermissionDenied);
    fixture.status(200);
  });

  test("overlaps a cold file page with Viewed and only verifies the summary on a warm read", async () => {
    const rest = "/repos/itsoltech/canopy/pulls/42/files";
    const requests = () => [rest, "CanopyViewed", "CanopyPullRequest"].map((k) => fixture.counts.get(k) ?? 0);
    await gw.api.refreshPullRequest({ pullRequestId: pr });
    const before = requests();
    const filesStarted = Promise.withResolvers<void>();
    const viewedStarted = Promise.withResolvers<void>();
    const client = gw.core.github.prs.client;
    const cached = client.cached.bind(client);

    // Rendezvous before the shared per-identity HTTP budget serializes actual network requests.
    const paired = spyOn(client, "cached").mockImplementation(async (row, key) => {
      if (key.startsWith("patches:")) {
        filesStarted.resolve();
        await viewedStarted.promise;
      }

      if (key.startsWith("viewed:")) {
        viewedStarted.resolve();
        await filesStarted.promise;
      }

      return cached(row, key);
    });

    try {
      const cold = await gw.api.listPullRequestFiles({ pullRequestId: pr });
      const after = requests();
      expect(after.map((v, i) => v - before[i]!)).toEqual([1, 3, 2]);
      const warm = await gw.api.listPullRequestFiles({ pullRequestId: pr });
      expect(warm.files).toEqual(cold.files);
      expect(requests().map((v, i) => v - after[i]!)).toEqual([0, 0, 1]);
      fixture.base("d".repeat(40));
      const rebased = await gw.api.listPullRequestFiles({ pullRequestId: pr, baseSha: readBase }).catch((e) => e);
      expect(ConnectError.from(rebased).code).toBe(Code.FailedPrecondition);
    } finally {
      filesStarted.resolve();
      viewedStarted.resolve();
      paired.mockRestore();
      fixture.base(readBase);
      await gw.api.refreshPullRequest({ pullRequestId: pr });
    }
  });

  test("rejects a file page when its repository account mapping changes under identical SHAs", async () => {
    const repositoryName = "itsoltech/canopy";
    const mapping = await gw.api.getGitHubRepositoryAccount({ repositoryName });
    const release = Promise.withResolvers<void>();
    const filesStarted = Promise.withResolvers<void>();
    const client = gw.core.github.prs.client;
    const cached = client.cached.bind(client);

    const delayed = spyOn(client, "cached").mockImplementation(async (row, key) => {
      if (key.startsWith("patches:")) {
        filesStarted.resolve();
        await release.promise;
      }

      return cached(row, key);
    });

    const result = gw.api.listPullRequestFiles({ pullRequestId: pr, refresh: true }).catch((e) => e);

    try {
      await filesStarted.promise;
      await gw.api.setGitHubRepositoryAccount({
        repositoryName,
        accountId: mapping.accountId,
        expectedRevision: mapping.revision,
      });
      release.resolve();
      expect(ConnectError.from(await result).code).toBe(Code.FailedPrecondition);
    } finally {
      release.resolve();
      delayed.mockRestore();
    }
  });

  test("paginates 300 files without sending patches; rejects stale SHAs, binary and huge patches", async () => {
    const list = await gw.api.listPullRequestFiles({ pullRequestId: pr });
    expect(list.files).toHaveLength(30);
    expect(list.files[1]!.patchState).toBe("binary");
    expect(list.files[2]!.previousPath).toBe("old.ts");
    expect(list.files[3]!.patchState).toBe("truncated");

    const patch = await gw.api.getPullRequestDiff({
      pullRequestId: pr,
      path: "src/safe.ts",
      resourceId: "1",
      headSha: readHead,
      baseSha: readBase,
    });

    expect(patch.patch).toContain("+new");
    const huge = await gw.api.getPullRequestDiff({ pullRequestId: pr, path: "src/file-3.ts", resourceId: "1" });
    expect(huge.patch).toBe("");
    let total = list.files.length;
    let cursor = list.page!.nextCursor;

    while (cursor) {
      const page = await gw.api.listPullRequestFiles({ pullRequestId: pr, cursor });
      total += page.files.length;
      cursor = page.page?.nextCursor ?? "";
    }

    expect(total).toBe(300);
    const commit = await gw.api.listPullRequestFiles({ pullRequestId: pr, commitSha: readHead });
    expect(commit.files[0]!.path).toBe("src/safe.ts");
    const commitsPath = "/repos/itsoltech/canopy/pulls/42/commits";
    const before = fixture.counts.get(commitsPath) ?? 0;
    const foreign = "f".repeat(40);
    fixture.base("d".repeat(40));

    try {
      await gw.api.refreshPullRequest({ pullRequestId: pr });
      const denied = await gw.api.listPullRequestFiles({ pullRequestId: pr, commitSha: foreign }).catch((e) => e);
      expect(ConnectError.from(denied).code).toBe(Code.NotFound);
      expect((fixture.counts.get(commitsPath) ?? 0) - before).toBe(1);
      expect(fixture.counts.has(`/repos/itsoltech/canopy/commits/${foreign}`)).toBe(false);
    } finally {
      fixture.base(readBase);
      await gw.api.refreshPullRequest({ pullRequestId: pr });
    }

    fixture.race();

    const raced = await gw.api
      .listPullRequestFiles({ pullRequestId: pr, refresh: true, headSha: readHead })
      .catch((e) => e);

    expect(ConnectError.from(raced).code).toBe(Code.FailedPrecondition);
    fixture.head(readHead);
    await gw.api.refreshPullRequest({ pullRequestId: pr });
  });
});
