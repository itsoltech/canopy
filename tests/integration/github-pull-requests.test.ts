import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import { dockerAvailable } from "@canopy/db/testing";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GitHubAccounts } from "../../apps/gateway/src/github/service.ts";
import { GatewayStore } from "@canopy/gateway/store";
import { connectGitHub, githubPrFixture, githubThread } from "./support/github-pr.ts";
import { failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

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
    expect(items.links[0]!.summary!.state).toBe("merged");
    expect((await gw.api.getThread({ threadId: thread })).thread!.pullRequestCount).toBe(2);
    const output = inspect([snapshot, linked, gw.worker.commands, gw.worker.configs], { depth: null });

    for (const secret of fixture.secrets) expect(output).not.toContain(secret);
  });

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
    const { eventually } = await import("./support/gateway.ts");
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
