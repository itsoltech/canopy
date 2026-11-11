import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { dockerAvailable } from "@canopy/db/testing";
import { mutationRequest } from "@canopy/domain/github-mutations";
import { reviewRevision } from "@canopy/domain/github-review";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GitHubAccounts } from "../../apps/gateway/src/github/service.ts";
import { GitHubPullRequests } from "../../apps/gateway/src/github/pull-requests.ts";
import { GitHubMutations } from "../../apps/gateway/src/github/mutations.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";
import { githubBrowser } from "./support/github-pr.ts";
import { linkedRead, readHead } from "./support/github-read.ts";
import { reviewFixture } from "./support/github-review.ts";

describe.skipIf(!dockerAvailable)("GitHub full review through gRPC", () => {
  const fixture = reviewFixture(),
    browser = githubBrowser();

  let gw: TestGateway, snapshot: github.PullRequestSnapshot, pr: string;

  const request = (action: string, fields: Partial<github.PullRequestMutationRequest> = {}) =>
    Object.assign(mutationRequest(snapshot, crypto.randomUUID(), action), fields);

  const code = (p: Promise<object>) =>
    p.then(
      () => 0,
      (cause) => ConnectError.from(cause).code,
    );

  const inline = (fields: Partial<github.PullRequestMutationRequest> = {}) =>
    request("add_review_comment", {
      path: "src/safe.ts",
      side: "RIGHT",
      line: 9,
      commitSha: snapshot.summary!.headSha,
      sourcePage: 1,
      body: "Check the new line",
      ...fields,
    });

  const draft = async (client = browser) => {
    const pages: github.PullRequestReviewDraft[] = [];
    let cursor = "";

    do {
      const page = await gw.api.getPullRequestReviewDraft({ pullRequestId: pr, cursor, refresh: true }, client);
      pages.push(page);
      cursor = page.page?.nextCursor ?? "";
    } while (cursor);

    return { resourceId: pages[0]!.id, reviewRevision: reviewRevision(pages), pages };
  };

  const submit = async (verdict = "COMMENT", fields: Partial<github.PullRequestMutationRequest> = {}) => {
    const d = await draft();

    return gw.api.submitPullRequestReview(
      request("submit_review", {
        resourceId: d.resourceId,
        reviewRevision: d.reviewRevision,
        verdict,
        body: "Review summary",
        ...fields,
      }),
      browser,
    );
  };

  beforeAll(async () => {
    gw = await startTestGateway({ github: fixture.options });
    ({ pr } = await linkedRead(gw, fixture));
    snapshot = await gw.api.getPullRequest({ pullRequestId: pr });
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
    fixture.close();
  });

  test("LEFT, RIGHT, multiline and cross-side anchors retain their original blob lines and SHA", async () => {
    for (const fields of [
      { side: "LEFT", line: 9 },
      { side: "RIGHT", line: 10 },
      { side: "LEFT", line: 10, startSide: "LEFT", startLine: 8 },
      { side: "RIGHT", line: 10, startSide: "RIGHT", startLine: 8 },
      { side: "RIGHT", line: 10, startSide: "LEFT", startLine: 9 },
    ]) {
      const r = inline({ ...fields, singleComment: true });
      const receipt = await gw.api.addPullRequestReviewComment(r, browser);
      expect(receipt.state).toBe("succeeded");
      const review = fixture.reviews.get(receipt.upstreamId)!;
      expect(review.state).toBe("COMMENT");
      expect(review.sha).toBe(readHead);
      expect(review.comments[0]).toMatchObject({ ...fields, path: "src/safe.ts", body: r.body, sha: readHead });
    }

    const before = fixture.writes;

    for (const fields of [
      { side: "RIGHT", line: 999 },
      { side: "LEFT", line: 0 },
      { side: "WRONG", line: 9 },
      { side: "RIGHT", line: 30, startSide: "RIGHT", startLine: 9 },
      { side: "RIGHT", line: 8, startSide: "RIGHT", startLine: 10 },
    ])
      expect(await code(gw.api.addPullRequestReviewComment(inline(fields), browser))).toBe(Code.InvalidArgument);
    expect(await code(gw.api.addPullRequestReviewComment(inline({ commitSha: "d".repeat(40) }), browser))).toBe(
      Code.FailedPrecondition,
    );
    expect(fixture.writes).toBe(before);
  }, 60_000);

  test("pending from another device is paginated; single comments never submit it", async () => {
    const seeded = fixture.seed(101, 127);
    const anotherDevice = githubBrowser();
    const d = await draft(anotherDevice);
    expect(d.resourceId).toBe(seeded.id);
    expect(d.pages.map((p) => p.comments.length)).toEqual([50, 50, 27]);
    const before = fixture.writes;
    expect(await code(gw.api.addPullRequestReviewComment(inline({ singleComment: true }), browser))).toBe(
      Code.FailedPrecondition,
    );
    expect(
      await code(
        gw.api.submitPullRequestReview(
          request("submit_review", {
            resourceId: seeded.id,
            reviewRevision: reviewRevision(d.pages.slice(0, 1)),
            verdict: "COMMENT",
          }),
          browser,
        ),
      ),
    ).toBe(Code.FailedPrecondition);
    expect(fixture.writes).toBe(before);
    const added = await gw.api.addPullRequestReviewComment(inline({ resourceId: seeded.id }), anotherDevice);
    expect(added.state).toBe("succeeded");
    expect(seeded.comments).toHaveLength(128);
    expect(
      await code(
        gw.api.submitPullRequestReview(
          request("submit_review", {
            resourceId: seeded.id,
            reviewRevision: d.reviewRevision,
            verdict: "COMMENT",
          }),
          browser,
        ),
      ),
    ).toBe(Code.FailedPrecondition);
    expect((await submit()).state).toBe("succeeded");
    expect(seeded.state).toBe("COMMENT");
    expect((await draft()).pages[0]?.id).toBe("");
  }, 60_000);

  test("each verdict submits exactly one review, with or without pending comments", async () => {
    for (const verdict of ["COMMENT", "APPROVE", "REQUEST_CHANGES"]) {
      const r = inline();

      const [a, b] = await Promise.all([
        gw.api.addPullRequestReviewComment(r, browser),
        gw.api.addPullRequestReviewComment(r, browser),
      ]);

      expect(a.state).toBe("succeeded");
      expect(b.upstreamId).toBe(a.upstreamId);
      const d = await draft();
      expect(d.pages[0]?.totalCount).toBe(1);
      const receipt = await submit(verdict);
      expect(receipt.state).toBe("succeeded");
      expect(fixture.reviews.get(receipt.upstreamId)).toMatchObject({ state: verdict, body: "Review summary" });
    }

    expect((await submit("APPROVE")).state).toBe("succeeded");
  }, 60_000);

  test("a push before submit requires fresh pages and an explicit check of outdated anchors", async () => {
    await gw.api.addPullRequestReviewComment(inline(), browser);
    const d = await draft();

    const r = request("submit_review", {
      resourceId: d.resourceId,
      reviewRevision: d.reviewRevision,
      verdict: "COMMENT",
    });

    const before = fixture.writes;
    fixture.head("c".repeat(40));
    expect(await code(gw.api.submitPullRequestReview(r, browser))).toBe(Code.FailedPrecondition);
    snapshot = await gw.api.refreshPullRequest({ pullRequestId: pr });
    const fresh = await draft();
    expect(fresh.pages[0]?.comments[0]?.outdated).toBe(true);
    expect(fresh.pages[0]?.comments[0]?.comment?.sha).toBe(readHead);
    expect(await code(submit())).toBe(Code.FailedPrecondition);
    expect(fixture.writes).toBe(before);
    expect((await submit("COMMENT", { acknowledgeOutdated: true })).state).toBe("succeeded");
    fixture.head(readHead);
    snapshot = await gw.api.refreshPullRequest({ pullRequestId: pr });
  }, 60_000);

  test("resolve, unresolve, own review edits and confirmed deletion use verified targets", async () => {
    const posted = await gw.api.addPullRequestReviewComment(inline({ singleComment: true }), browser);
    const review = fixture.reviews.get(posted.upstreamId)!;
    const thread = [...fixture.threads.values()].find((t) => t.review === review)!;

    for (const resolved of [true, false]) {
      const receipt = await gw.api.setPullRequestReviewThreadResolved(
        request("resolve_thread", { resourceId: thread.id, resolved }),
        browser,
      );

      expect(receipt.state).toBe("succeeded");
      expect(thread.resolved).toBe(resolved);
    }

    const comment = review.comments[0]!;
    expect(
      (
        await gw.api.updatePullRequestComment(
          request("update_comment", {
            resourceId: comment.id,
            commentKind: "review",
            body: "Updated inline comment",
          }),
          browser,
        )
      ).state,
    ).toBe("succeeded");
    expect(comment.body).toBe("Updated inline comment");
    const r = request("delete_comment", { resourceId: comment.id, commentKind: "review" });
    const prepared = await gw.api.preparePullRequestMutation(r, browser);
    expect(
      (await gw.api.deletePullRequestComment({ ...r, confirmationId: prepared.confirmationId }, browser)).state,
    ).toBe("succeeded");
    expect(review.comments).toHaveLength(0);
    const pending = fixture.seed(101);
    const d = await draft();
    const discard = request("discard_review", { resourceId: pending.id, reviewRevision: d.reviewRevision });
    expect(await code(gw.api.discardPullRequestReview(discard, browser))).toBe(Code.FailedPrecondition);
    const confirmation = await gw.api.preparePullRequestMutation(discard, browser);
    expect(
      (await gw.api.discardPullRequestReview({ ...discard, confirmationId: confirmation.confirmationId }, browser))
        .state,
    ).toBe("succeeded");
    expect(fixture.reviews.has(pending.id)).toBe(false);
  }, 60_000);

  test("uncertain review submissions survive restart and never replay; audit omits review text", async () => {
    await gw.api.addPullRequestReviewComment(inline(), browser);
    const d = await draft();

    const r = request("submit_review", {
      resourceId: d.resourceId,
      reviewRevision: d.reviewRevision,
      verdict: "COMMENT",
      body: "Private review summary",
    });

    const before = fixture.writes;
    fixture.loseResponse();
    expect((await gw.api.submitPullRequestReview(r, browser)).state).toBe("uncertain");
    expect((await gw.api.submitPullRequestReview(r, browser)).state).toBe("uncertain");
    const restarted = new GitHubAccounts(gw.runtime, gw.userId, fixture.options);

    try {
      const binding = (await restarted.run((s) => s.mutationGet(gw.userId, r.clientRequestId)))[0]!.client_binding;
      const mutations = new GitHubMutations(new GitHubPullRequests(restarted, async () => {}));
      expect((await mutations.run(r, binding)).state).toBe("uncertain");
    } finally {
      await restarted.stop();
    }

    expect(fixture.writes - before).toBe(1);

    const audit = await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql<{
          details: Record<string, string>;
        }>`SELECT details FROM audit_log WHERE details->>'requestId'=${r.clientRequestId}`;
      }),
    );

    expect(JSON.stringify(audit)).not.toContain(r.body);
    expect(JSON.stringify(audit)).not.toContain(fixture.secrets.at(-1)!);
  }, 60_000);
});
