import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { inspect } from "node:util";
import { dockerAvailable } from "@canopy/db/testing";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GitHubAccounts } from "../../apps/gateway/src/github/service.ts";
import { GatewayStore } from "@canopy/gateway/store";
import { connectGitHub, githubPrFixture, githubThread } from "./support/github-pr.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("manual GitHub PRs over gRPC and controlled HTTP", () => {
  let gw: TestGateway;
  let fixture: ReturnType<typeof githubPrFixture>;
  let account: string;
  let thread: string;
  let pr: string;
  beforeAll(async () => {
    fixture = githubPrFixture();
    gw = await startTestGateway({ github: fixture.options });
    account = await connectGitHub(gw, fixture);
    thread = await githubThread(gw);
    await gw.api.setGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy", accountId: account });
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
    fixture?.close();
  });

  const list = () => gw.api.listThreadPullRequests({ threadId: thread });

  const link = async (number = 42) =>
    gw.api.linkThreadPullRequest({
      threadId: thread,
      url: `https://github.com/itsoltech/canopy/pull/${number}`,
      expectedRevision: (await list()).revision,
    });

  test("verified manual links are many-to-many and snapshots carry safe, complete metadata", async () => {
    const linked = await link();
    pr = linked.links[0]!.summary!.ref!.id;
    const snapshot = await gw.api.getPullRequest({ pullRequestId: pr });
    expect(snapshot.summary!.state).toBe("open");
    expect(snapshot.reviewers).toHaveLength(2);
    expect(snapshot.checks).toHaveLength(16);
    expect(snapshot.labelDetails[0]?.color).toBe("d73a4a");
    expect(snapshot.body).toContain("<script>"); // Token renderers display this as text, never HTML.
    expect(snapshot.summary!.headSha).toBe("a".repeat(40));
    const other = await githubThread(gw);

    const second = await gw.api.linkThreadPullRequest({
      threadId: other,
      url: "https://github.com/itsoltech/canopy/pull/42",
    });

    expect(second.links[0]!.summary!.ref!.id).toBe(pr);
    await link(43);
    const items = await list();
    expect(items.links).toHaveLength(2);
    expect(items.links.map((l) => l.summary!.state)).toEqual(["open", "merged"]);
    expect((await gw.api.getThread({ threadId: thread })).thread!.pullRequestCount).toBe(2);
    const output = inspect([snapshot, linked, gw.worker.commands, gw.worker.configs], { depth: null });

    for (const secret of fixture.secrets) expect(output).not.toContain(secret);
  });

  test("a PR refresh updates its linked threads and a current cached read leaves their live streams quiet", async () => {
    const first = await githubThread(gw);
    const second = await githubThread(gw);
    const unrelated = await githubThread(gw);

    const attach = (threadId: string, number: number) =>
      gw.api.linkThreadPullRequest({ threadId, url: `https://github.com/itsoltech/canopy/pull/${number}` });

    await attach(first, 47);
    const shared = await attach(second, 47);
    await attach(unrelated, 48);
    const id = shared.links[0]!.summary!.ref!.id;
    const published: string[] = [];

    const reader = new GitHubAccounts(gw.runtime, gw.userId, fixture.options, (ids) => {
      published.push(...ids);

      return Promise.resolve();
    });

    try {
      fixture.echoText(" · updated");
      await reader.prs.get(id, true);
      expect(published.toSorted()).toEqual([first, second].toSorted());

      for (const threadId of [first, second]) {
        const value = await gw.api.getThread({ threadId });
        expect(value.thread?.newestPullRequest?.title).toContain(" · updated");
      }

      published.length = 0;
      expect((await reader.prs.get(id)).summary?.title).toContain(" · updated");
      expect(published).toEqual([]);

      // A second gateway can populate the shared cache before this gateway projects the thread.
      const beforeLoad = (await reader.prs.list(first)).revision;
      fixture.echoText(" · changed elsewhere");
      await reader.prs.load("itsoltech/canopy", 47, true);
      expect((await reader.prs.list(first)).revision).toBe(beforeLoad);
      expect(published).toEqual([]);
      await reader.prs.get(id);
      expect(published.toSorted()).toEqual([first, second].toSorted());
      expect((await gw.api.getThread({ threadId: first })).thread?.newestPullRequest?.title).toContain(
        " · changed elsewhere",
      );

      const links = await reader.prs.list(second);
      await gw.api.linkThreadPullRequest({
        threadId: second,
        url: "https://github.com/itsoltech/canopy/pull/49",
        expectedRevision: links.revision,
      });
      const revision = (await reader.prs.list(second)).revision;
      published.length = 0;
      fixture.echoText(" · older PR");
      await reader.prs.get(id, true);
      expect(published.toSorted()).toEqual([first, second].toSorted());
      expect((await gw.api.getThread({ threadId: second })).thread?.newestPullRequest?.ref?.number).toBe(49);
      expect((await reader.prs.list(second)).revision).toBe(revision + 1n);
      expect(
        (await reader.prs.list(second)).links.find((entry) => entry.summary?.ref?.id === id)?.summary?.title,
      ).toContain(" · older PR");
      fixture.advance(1000);
      await reader.prs.get(id, true);
      expect((await reader.prs.list(second)).revision).toBe(revision + 1n);
    } finally {
      fixture.echoText("");
      await reader.stop();
    }
  });

  test.each(["complete", "partial"])(
    "concurrent readers publish one revision for a %s edit to an older PR",
    async (kind) => {
      const threadId = await githubThread(gw);
      const name = "itsoltech/canopy";
      const number = kind === "complete" ? 51 : 53;
      const first = await gw.api.linkThreadPullRequest({ threadId, url: `https://github.com/${name}/pull/${number}` });
      const id = first.links[0]!.summary!.ref!.id;

      const linked = await gw.api.linkThreadPullRequest({
        threadId,
        url: `https://github.com/${name}/pull/${number + 1}`,
        expectedRevision: first.revision,
      });

      const published: string[] = [];

      const peers = Array.from(
        { length: 2 },
        () =>
          new GitHubAccounts(gw.runtime, gw.userId, fixture.options, async (ids) => {
            published.push(...ids);
          }),
      );

      const release = Promise.withResolvers<void>();
      const before = fixture.calls;
      fixture.echoText(" · single edit");
      fixture.partial(kind === "partial");
      fixture.gate(release.promise);
      // The plain loader owns the first fill. Each reader has sampled the previous cached summary when it calls read().
      const loader = gw.core.github.prs.load(name, number, true);
      const pending = [loader];
      const started = peers.map((peer) => spyOn(peer.prs.client, "read"));

      try {
        expect(
          await eventually(
            async () => fixture.calls,
            (count) => count > before,
          ),
        ).toBeGreaterThan(before);

        for (const peer of peers) {
          pending.push(peer.prs.get(id, true), peer.prs.get(id, true));
        }

        const reading = Promise.all(pending);

        // A rejected request must surface even if it failed before reading the shared cache.
        const overlapped = await Promise.race([
          eventually(async () => started.every((spy) => spy.mock.calls.length >= 2), Boolean),
          reading.then(() => false),
        ]);

        expect(overlapped).toBe(true);
        release.resolve();
        await reading;
        expect((await loader).completeness).toBe(kind);
        const current = await peers[0]!.prs.list(threadId);
        expect(current.revision).toBe(linked.revision + 1n);
        expect(current.links.find((link) => link.summary?.ref?.id === id)?.summary?.title).toContain("single edit");
        expect((await gw.api.getThread({ threadId })).thread!.newestPullRequest?.ref?.number).toBe(number + 1);
        expect(published).toEqual([threadId]);
        await peers[1]!.prs.get(id);
        expect(published).toEqual([threadId]);
      } finally {
        release.resolve();
        await Promise.allSettled(pending);

        for (const spy of started) spy.mockRestore();
        fixture.gate(Promise.resolve());
        fixture.partial(false);
        fixture.echoText("");
        await Promise.all(peers.map((peer) => peer.stop()));
      }
    },
    20_000,
  );

  test("unlink survives restart and fences an in-flight manual link and later automatic evidence", async () => {
    const current = await list();
    let release = () => {};

    fixture.gate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    const pending = gw.api
      .linkThreadPullRequest({
        threadId: thread,
        url: "https://github.com/itsoltech/canopy/pull/42",
        expectedRevision: current.revision,
      })
      .catch(ConnectError.from);

    // The HTTP request must have left before unlink commits.
    const before = fixture.calls;
    await eventually(
      async () => fixture.calls,
      (n) => n > before,
    );
    await gw.api.unlinkThreadPullRequest({ threadId: thread, pullRequestId: pr, expectedRevision: current.revision });
    release();
    fixture.gate(Promise.resolve());
    const rejected = await pending;
    expect(rejected).toBeInstanceOf(ConnectError);
    expect(ConnectError.from(rejected).code).toBe(Code.Aborted);
    const restarted = new GitHubAccounts(gw.runtime, gw.userId, fixture.options);
    const after = await restarted.prs.list(thread);
    await restarted.run((s) => s.prLink(gw.userId, thread, pr, after.revision, "auto"));
    expect((await restarted.prs.list(thread)).links.some((l) => l.summary?.ref?.id === pr)).toBe(false);
    await restarted.stop();
    await link();
    expect((await list()).links.some((l) => l.summary?.ref?.id === pr)).toBe(true);
  });

  test("conditional REST reuses ETags and GraphQL reads deduplicate across service instances", async () => {
    const selected = await gw.api.getGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy" });
    await gw.api.setGitHubRepositoryAccount({
      repositoryName: "itsoltech/canopy",
      accountId: account,
      expectedRevision: selected.revision,
    });
    expect(fixture.notModified).toBeGreaterThan(0);
    const second = new GitHubAccounts(gw.runtime, gw.userId, fixture.options);
    const before = fixture.calls;
    await Promise.all([gw.api.refreshPullRequest({ pullRequestId: pr }), second.prs.get(pr, true)]);
    expect(fixture.calls - before).toBe(1);
    await second.stop();

    // Retention can recreate generation 1 while an older generation 1 remains in RAM.
    for (const marker of ["after first eviction", "after second eviction"]) {
      await gw.core.github.run((s) => s.cacheInvalidate(gw.userId, account));
      fixture.echoText(` · ${marker}`);
      const recreated = await gw.api.refreshPullRequest({ pullRequestId: pr });
      expect(recreated.summary!.title).toContain(marker);
    }

    fixture.echoText("");

    const rows = await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql<{
          used: number;
        }>`SELECT used FROM github_api_budgets WHERE github_user_id='101' AND resource='graphql'`;
      }),
    );

    expect(rows[0]!.used).toBeGreaterThanOrEqual(3);
  });

  test("rate limit backoff persists, preserves stale data, and does not retry a denied request", async () => {
    fixture.status(429);
    const before = fixture.calls;
    const stale = await gw.api.refreshPullRequest({ pullRequestId: pr });
    expect(stale.stale).toBe(true);
    expect(stale.detail).toContain("limit");
    await gw.api.refreshPullRequest({ pullRequestId: pr });
    expect(fixture.calls - before).toBe(1);
    fixture.status(200);
    fixture.advance(100_000);
    const fresh = await gw.api.refreshPullRequest({ pullRequestId: pr });
    expect(fresh.stale).toBe(false);
    fixture.partial(true);
    const partial = await gw.api.refreshPullRequest({ pullRequestId: pr });
    expect(partial.completeness).toBe("partial");
    expect(partial.labels).toHaveLength(12);
    fixture.partial(false);
  });

  test("changing accounts does not reuse private content; foreign owners cannot read the canonical ref or links", async () => {
    const otherAccount = await connectGitHub(gw, fixture, 202);
    const selected = await gw.api.getGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy" });
    await gw.api.setGitHubRepositoryAccount({
      repositoryName: "itsoltech/canopy",
      accountId: otherAccount,
      expectedRevision: selected.revision,
    });
    const fresh = await gw.api.getPullRequest({ pullRequestId: pr });
    expect(fresh.accountId).toBe(otherAccount);
    expect(fresh.summary!.title).toContain("account 202");

    const foreignOwner = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("pr-foreign@example.test", "Foreign")),
    );

    const foreign = new GitHubAccounts(gw.runtime, foreignOwner, fixture.options);
    expect(await failure(foreign.prs.get(pr))).toContain("not found");
    expect(await failure(foreign.prs.list(thread))).toContain("not found");
    expect((await foreign.prs.repositories.get("itsoltech/canopy")).candidates).toHaveLength(0);
    await foreign.stop();
    // Echoed credentials are redacted before parsing, persistence or DTO delivery.
    fixture.echoText(fixture.secrets.join(" "));
    const redacted = await gw.api.refreshPullRequest({ pullRequestId: pr });

    for (const secret of fixture.secrets.slice(-2)) expect(inspect(redacted, { depth: null })).not.toContain(secret);
    fixture.echoText("");
    await gw.api.disconnectGitHubAccount({ accountId: otherAccount });
    expect((await list()).links.every((l) => !l.summary?.title)).toBe(true);
    const fallback = await gw.api.getPullRequest({ pullRequestId: pr });
    expect(fallback.accountId).toBe(account);
    expect(fallback.summary!.title).toContain("account 101");
    expect((await list()).links.every((l) => !l.summary?.title.includes("account 202"))).toBe(true);
    const restored = await connectGitHub(gw, fixture, 202);
    expect(restored).toBe(otherAccount);
    expect((await gw.api.getPullRequest({ pullRequestId: pr })).accountId).toBe(account);
    fixture.status(403);
    expect(await failure(gw.api.refreshPullRequest({ pullRequestId: pr }))).toContain("permissions");
    expect((await list()).links.every((l) => !l.summary?.title)).toBe(true);
    fixture.status(200);
  });
});
