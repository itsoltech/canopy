import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { github } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { mutationRequest } from "@canopy/domain/github-mutations";
import { GitHubAccounts } from "../../apps/gateway/src/github/service.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";
import { linkedRead } from "./support/github-read.ts";
import { githubBrowser, connectGitHub } from "./support/github-pr.ts";
import { mutationFixture, fixturePath } from "./support/github-mutations.ts";

describe.skipIf(!dockerAvailable)("durable GitHub user mutations", () => {
  const fixture = mutationFixture();
  const browser = githubBrowser();
  let gw: TestGateway;
  let snapshot: github.PullRequestSnapshot;
  let pr: string;
  beforeAll(async () => {
    gw = await startTestGateway({ github: fixture.options });
    ({ pr } = await linkedRead(gw, fixture));
    snapshot = await gw.api.getPullRequest({ pullRequestId: pr });
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
    fixture.close();
  });

  const request = (action: string, fields: Partial<github.PullRequestMutationRequest> = {}) =>
    Object.assign(mutationRequest(snapshot, crypto.randomUUID(), action), fields);

  const code = async (promise: Promise<object>) =>
    promise.then(
      () => 0,
      (e) => ConnectError.from(e).code,
    );

  const sql = <A extends object>(query: string, values: readonly (string | number)[] = []) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* SqlClient.SqlClient;

        return yield* client.unsafe<A>(query, values);
      }),
    );

  test("double clicks send one comment; its receipt survives a new service", async () => {
    const r = request("create_comment", { body: "# A durable comment\n\n**Markdown**" });
    const before = fixture.writes;

    const [a, b] = await Promise.all([
      gw.api.createPullRequestComment(r, browser),
      gw.api.createPullRequestComment(r, browser),
    ]);

    expect(a.state).toBe("succeeded");
    expect(b.state).toBe("succeeded");
    expect(a.upstreamId).toBe(b.upstreamId);
    expect(fixture.writes - before).toBe(1);
    expect(fixture.comments.get(a.upstreamId)?.body).toBe(r.body);
    expect(await code(gw.api.createPullRequestComment({ ...r, body: "Changed" }, browser))).toBe(Code.AlreadyExists);
    const restarted = new GitHubAccounts(gw.runtime, gw.userId, fixture.options);

    try {
      const row = (await restarted.run((s) => s.mutationGet(gw.userId, r.clientRequestId)))[0]!;
      expect(row.state).toBe("succeeded");
      expect(row.upstream_id).toBe(a.upstreamId);
    } finally {
      await restarted.stop();
    }

    const audit = await sql<{ action: string; details: Record<string, string> }>(
      "SELECT action,details FROM audit_log WHERE details->>'requestId'=$1 ORDER BY created_at",
      [r.clientRequestId],
    );

    expect(audit.map((a) => a.details["outcome"])).toEqual(["prepared", "in_flight", "succeeded"]);
    expect(JSON.stringify(audit)).not.toContain(r.body);
    expect(JSON.stringify(audit)).not.toContain(fixture.secrets.at(-1)!);
  }, 30_000);

  test("reply and own-comment edits use verified PR targets; deletion requires confirmation", async () => {
    const reply = await gw.api.replyPullRequestReviewThread(
      request("reply", { resourceId: "THREAD_OWN", body: "A reply" }),
      browser,
    );

    expect(reply.state).toBe("succeeded");
    expect(fixture.comments.get(reply.upstreamId)?.review).toBe(true);

    for (const [id, kind] of [
      ["OWN", "issue"],
      ["REVIEW_OWN", "review"],
    ] as const) {
      const update = await gw.api.updatePullRequestComment(
        request("update_comment", { resourceId: id, commentKind: kind, body: `Updated ${kind}` }),
        browser,
      );

      expect(update.state).toBe("succeeded");
      expect(fixture.comments.get(id!)?.body).toBe(`Updated ${kind}`);
    }

    const r = request("delete_comment", { resourceId: reply.upstreamId, commentKind: "review" });
    const prepared = await gw.api.preparePullRequestMutation(r, browser);
    const before = fixture.writes;
    expect(await code(gw.api.deletePullRequestComment(r, browser))).toBe(Code.FailedPrecondition);
    expect(
      await code(gw.api.deletePullRequestComment({ ...r, confirmationId: prepared.confirmationId }, githubBrowser())),
    ).toBe(Code.AlreadyExists);
    expect(fixture.writes).toBe(before);
    expect(
      (await gw.api.deletePullRequestComment({ ...r, confirmationId: prepared.confirmationId }, browser)).state,
    ).toBe("succeeded");
    expect(fixture.comments.has(reply.upstreamId)).toBe(false);
  }, 30_000);

  test("lost responses and abandoned in-flight intents become uncertain and never replay", async () => {
    fixture.loseResponse();
    const r = request("create_comment", { body: "Sent before response was lost" });
    const before = fixture.writes;
    const receipt = await gw.api.createPullRequestComment(r, browser);
    expect(receipt.state).toBe("uncertain");
    expect(receipt.detail).toBe("Couldn't confirm. Check on GitHub");
    fixture.advance(60_000);
    expect((await gw.api.createPullRequestComment(r, browser)).state).toBe("uncertain");
    expect(
      (await gw.api.getPullRequestMutation({ pullRequestId: pr, clientRequestId: r.clientRequestId }, browser)).state,
    ).toBe("uncertain");
    expect(fixture.writes - before).toBe(1);
    const abandoned = request("create_comment", { body: "Crashed intent" });
    await gw.api.preparePullRequestMutation(abandoned, browser);
    await sql(
      "UPDATE github_mutation_receipts SET state='in_flight',lease_until=now()-interval '1 second' WHERE request_id=$1::uuid",
      [abandoned.clientRequestId],
    );
    expect((await gw.api.createPullRequestComment(abandoned, browser)).state).toBe("uncertain");
    expect(fixture.writes - before).toBe(1);
  }, 30_000);

  test("expired deletion confirmation cannot send an HTTP mutation", async () => {
    const r = request("delete_comment", { resourceId: "OWN", commentKind: "issue" });
    const prepared = await gw.api.preparePullRequestMutation(r, browser);
    await sql("UPDATE github_mutation_receipts SET expires_at=now()-interval '1 second' WHERE request_id=$1::uuid", [
      r.clientRequestId,
    ]);
    const before = fixture.writes;
    expect(
      await code(gw.api.deletePullRequestComment({ ...r, confirmationId: prepared.confirmationId }, browser)),
    ).toBe(Code.FailedPrecondition);
    expect(fixture.writes).toBe(before);
    expect(fixture.comments.has("OWN")).toBe(true);
  }, 30_000);

  test("Viewed is GitHub state across two devices, with dismissed and rejection rollback", async () => {
    const files = await gw.api.listPullRequestFiles({ pullRequestId: pr, refresh: true });
    expect(files.files.slice(0, 3).map((f) => f.viewerViewedState)).toEqual(["UNVIEWED", "VIEWED", "DISMISSED"]);
    expect(files.viewedCount).toBe(1);
    expect(files.viewedTotal).toBe(300);
    const r = request("viewed", { path: fixturePath(0), viewed: true });
    expect((await gw.api.setPullRequestFileViewed(r, browser)).state).toBe("succeeded");
    const anotherDevice = githubBrowser();
    const second = await gw.api.listPullRequestFiles({ pullRequestId: pr, refresh: true }, anotherDevice);
    expect(second.files[0]?.viewerViewedState).toBe("VIEWED");
    expect(second.viewedCount).toBe(2);
    expect(
      (await gw.api.setPullRequestFileViewed(request("viewed", { path: fixturePath(0), viewed: false }), anotherDevice))
        .state,
    ).toBe("succeeded");
    fixture.reject(true);
    expect(
      (await gw.api.setPullRequestFileViewed(request("viewed", { path: fixturePath(0), viewed: true }), browser)).state,
    ).toBe("failed");
    fixture.reject(false);
    expect((await gw.api.listPullRequestFiles({ pullRequestId: pr, refresh: true })).files[0]?.viewerViewedState).toBe(
      "UNVIEWED",
    );
  }, 30_000);

  test("account changes isolate Viewed and never replay a previous account's receipt", async () => {
    const previous = snapshot;
    const second = await connectGitHub(gw, fixture, 102);
    const mapping = await gw.api.getGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy" });
    await gw.api.setGitHubRepositoryAccount({
      repositoryName: "itsoltech/canopy",
      accountId: second,
      expectedRevision: mapping.revision,
    });
    const other = await gw.api.refreshPullRequest({ pullRequestId: pr });
    const r = mutationRequest(other, crypto.randomUUID(), "viewed", { path: fixturePath(0), viewed: true });
    expect((await gw.api.setPullRequestFileViewed(r, browser)).state).toBe("succeeded");
    expect(fixture.viewState(101, fixturePath(0))).toBe("UNVIEWED");
    expect(fixture.viewState(102, fixturePath(0))).toBe("VIEWED");
    expect(
      await code(
        gw.api.createPullRequestComment(
          mutationRequest(previous, crypto.randomUUID(), "create_comment", { body: "Old account" }),
          browser,
        ),
      ),
    ).toBe(Code.FailedPrecondition);
    const current = await gw.api.getGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy" });
    await gw.api.setGitHubRepositoryAccount({
      repositoryName: "itsoltech/canopy",
      accountId: previous.accountId,
      expectedRevision: current.revision,
    });
    snapshot = await gw.api.refreshPullRequest({ pullRequestId: pr });
  }, 30_000);

  test("receipt migration enforces owner foreign keys and retains only structural parameters", async () => {
    const columns = await sql<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name='github_mutation_receipts'",
    );

    expect(columns.map((c) => c.column_name)).not.toContain("body");
    const rows = await sql<{ state: string }>("SELECT DISTINCT state FROM github_mutation_receipts");
    expect(rows.map((r) => r.state)).toContain("uncertain");

    const mismatch = await sql(
      "INSERT INTO github_mutation_receipts(owner_user_id,request_id,account_id,pull_request_id,client_binding,fingerprint,action,access_revision,mapping_revision,head_sha,expected_state,confirmation_id) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'client','hash','viewed',1,1,'sha','open',$5::uuid)",
      [crypto.randomUUID(), crypto.randomUUID(), snapshot.accountId, pr, crypto.randomUUID()],
    ).catch(() => "refused");

    expect(mismatch).toBe("refused");
  });
});
