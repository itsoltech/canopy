import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GitHubAccounts } from "../../apps/gateway/src/github/service.ts";
import { connectGitHub, githubPrFixture, githubThread } from "./support/github-pr.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("linked pull requests keep their last known summary", () => {
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

    pr = (await gw.api.linkThreadPullRequest({ threadId: thread, url: "https://github.com/itsoltech/canopy/pull/42" }))
      .links[0]!.summary!.ref!.id;
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
    fixture?.close();
  });

  const list = () => gw.api.listThreadPullRequests({ threadId: thread });

  const sql = (query: string, params: unknown[] = []) =>
    gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (s) => s.unsafe(query, params)));

  /** Token rotation moves the access revision; retention then drops the cached reads of the old one. */
  const loseCurrentReads = async () => {
    await sql("UPDATE github_accounts SET revision=revision+1 WHERE owner_user_id=$1::uuid", [gw.userId]);
    await sql("DELETE FROM github_pr_cache WHERE owner_user_id=$1::uuid", [gw.userId]);
  };

  test("after a restart the summary is available before GitHub answers, then refreshes in the background", async () => {
    await loseCurrentReads();
    const { pg, secretsKey, workerId, workerCredential } = gw;
    await gw.close(true);
    gw = await startTestGateway({ github: fixture.options, storage: { pg, secretsKey, workerId, workerCredential } });
    let release = () => {};

    fixture.gate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    const first = await list();
    const restored = first.links[0]!;
    expect(restored.summary!.title).toContain("Read-only pull request 42");
    expect(restored.summary!.state).toBe("open");
    expect(restored.summary!.checksState).not.toBe("");
    expect(restored.stale).toBe(true);
    expect(restored.detail).toBe("");
    // The sidebar projection uses the same last known summary.
    expect((await gw.api.getThread({ threadId: thread })).thread!.newestPullRequest?.title).toContain("request 42");

    const calls = fixture.calls;
    release();
    fixture.gate(Promise.resolve());

    // Clients learn about the refresh through the thread's pull request revision.
    const fresh = await eventually(list, (r) => r.revision > first.revision && r.links[0]?.stale === false);
    expect(fresh.links[0]!.detail).toBe("");
    expect(fixture.calls).toBeGreaterThanOrEqual(calls);
    // A fresh list does not start another read.
    const after = fixture.calls;
    await list();
    expect(fixture.calls).toBe(after);
  }, 60_000);

  test("a transient failure keeps the summary and gives its reason until Retry succeeds", async () => {
    await loseCurrentReads();
    await sql("UPDATE github_pull_requests SET refreshed_at=NULL WHERE owner_user_id=$1::uuid", [gw.userId]);
    fixture.status(429);

    const failed = (await eventually(list, (r) => r.links[0]?.detail !== "")).links[0]!;
    expect(failed.detail).toContain("GitHub's request limit is reached. Retry after");
    expect(failed.summary!.title).toContain("Read-only pull request 42");
    expect(failed.stale).toBe(true);

    // The background attempt is claimed once per interval, so polling the list does not loop on GitHub.
    const calls = fixture.calls;
    await list();
    await list();
    expect(fixture.calls).toBe(calls);

    fixture.status(200);
    fixture.advance(61_000);
    await gw.api.refreshPullRequest({ pullRequestId: pr });
    const recovered = (await list()).links[0]!;
    expect(recovered.stale).toBe(false);
    expect(recovered.detail).toBe("");
  }, 60_000);

  test("lost access drops the private summary and names the repository to check", async () => {
    await sql("UPDATE github_pull_requests SET refreshed_at=NULL WHERE owner_user_id=$1::uuid", [gw.userId]);
    fixture.status(404);
    const retry = await gw.api.refreshPullRequest({ pullRequestId: pr }).catch(ConnectError.from);
    expect(ConnectError.from(retry).code).toBe(Code.PermissionDenied);

    const denied = (await list()).links[0]!;
    expect(denied.detail).toBe("No access to itsoltech/canopy. Check the GitHub App installation.");
    expect(denied.summary!.title).toBe("");
    expect(denied.summary!.state).toBe("unavailable");
    expect(denied.summary!.ref!.number).toBe(42);

    fixture.status(200);
    await eventually(
      () => gw.api.refreshPullRequest({ pullRequestId: pr }).then(() => list()),
      (r) => r.links[0]?.detail === "" && !!r.links[0].summary?.title,
    );
  }, 60_000);

  test("last known summaries and refresh results stay with their owner", async () => {
    const other = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("pr-last-known@example.test", "Other owner")),
    );

    const foreign = new GitHubAccounts(gw.runtime, other, fixture.options);

    try {
      expect(
        await foreign.prs.list(thread).then(
          () => 0,
          (e) => ConnectError.from(e).code,
        ),
      ).toBe(Code.NotFound);
      await foreign.run((s) => s.prRemember(other, pr, account, { title: "Foreign" }));
      expect(await foreign.run((s) => s.prRefreshFailed(other, "itsoltech/canopy", 42, "Foreign", true))).toHaveLength(
        0,
      );
      expect(await foreign.run((s) => s.prRefreshClaim(other, pr))).toHaveLength(0);
      expect(await foreign.run((s) => s.prTouch(other, pr))).toHaveLength(0);
    } finally {
      await foreign.stop();
    }

    await loseCurrentReads();
    const own = (await list()).links[0]!;
    expect(own.summary!.title).toContain("Read-only pull request 42");
    expect(own.detail).toBe("");

    // Disconnecting the account removes what it read.
    await gw.api.disconnectGitHubAccount({ accountId: account });
    const disconnected = (await list()).links[0]!;
    expect(disconnected.summary!.title).toBe("");
    expect(disconnected.summary!.state).toBe("unavailable");
  });
});
