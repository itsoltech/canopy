import { beforeAll, afterAll, describe, test, expect } from "bun:test";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ui, type github } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { mutationRequest } from "@canopy/domain/github-mutations";
import { reviewRevision } from "@canopy/domain/github-review";
import { GatewayCore } from "@canopy/gateway/core";
import { GatewayStore } from "@canopy/gateway/store";
import { serviceTokenAuth, uiRoutes } from "@canopy/gateway/api";
import { startGrpcServer } from "@canopy/transport";
import { SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { githubBrowser, connectGitHub } from "./support/github-pr.ts";
import { linkedRead } from "./support/github-read.ts";
import { reviewFixture } from "./support/github-review.ts";

const code = (p: Promise<object>) =>
  p.then(
    () => 0,
    (cause) => ConnectError.from(cause).code,
  );

function caller(url: string, token = SERVICE_TOKEN) {
  return createClient(
    ui.GatewayService,
    createGrpcTransport({
      baseUrl: url,
      interceptors: [
        (next) => (req) => {
          req.header.set("authorization", `Bearer ${token}`);

          return next(req);
        },
      ],
    }),
  );
}

describe.skipIf(!dockerAvailable)("GitHub full review security", () => {
  const fixture = reviewFixture(),
    browser = githubBrowser();

  let gw: TestGateway, snapshot: github.PullRequestSnapshot, pr: string, other: GatewayCore;
  let server: Awaited<ReturnType<typeof startGrpcServer>>;

  const request = (action: string, fields: Partial<github.PullRequestMutationRequest> = {}) =>
    Object.assign(mutationRequest(snapshot, crypto.randomUUID(), action), fields);

  const inline = () =>
    request("add_review_comment", {
      path: "src/safe.ts",
      side: "RIGHT",
      line: 9,
      body: "Owner finding",
      sourcePage: 1,
      commitSha: snapshot.summary!.headSha,
    });

  const verdict = async (value: string) => {
    const d = await gw.api.getPullRequestReviewDraft({ pullRequestId: pr, refresh: true }, browser);

    return gw.api.submitPullRequestReview(
      request("submit_review", {
        resourceId: d.id,
        reviewRevision: reviewRevision([d]),
        verdict: value,
        body: "Summary",
      }),
      browser,
    );
  };

  beforeAll(async () => {
    gw = await startTestGateway({ github: fixture.options });
    ({ pr } = await linkedRead(gw, fixture));
    snapshot = await gw.api.getPullRequest({ pullRequestId: pr });

    const owner = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("review-other@example.test", "Other owner")),
    );

    other = new GatewayCore({
      runtime: gw.runtime,
      userId: owner,
      instanceId: "review-other",
      sshSecretsKey: gw.secretsKey,
      github: fixture.options,
    });
    server = await startGrpcServer({
      routes: uiRoutes(other),
      interceptors: [serviceTokenAuth(SERVICE_TOKEN)],
      host: "127.0.0.1",
      port: 0,
    });
  }, 60_000);
  afterAll(async () => {
    await other?.stopSweep();
    await server?.close();
    await gw?.close();
    fixture.close();
  });

  test("foreign owners, review IDs, threads and comments never reach a write", async () => {
    const foreign = fixture.seed(101, 1, "PR_fixture_43"),
      another = fixture.seed(102);

    const foreignThread = [...fixture.threads.values()].find((t) => t.review === foreign)!;
    const before = fixture.writes;
    expect(await code(caller(server.url).addPullRequestReviewComment(inline(), browser))).toBe(Code.NotFound);
    expect(await code(caller(server.url).getPullRequestReviewDraft({ pullRequestId: pr }, browser))).toBe(
      Code.NotFound,
    );

    for (const resourceId of [foreign.id, another.id]) {
      expect(await code(gw.api.addPullRequestReviewComment({ ...inline(), resourceId }, browser))).toBe(
        Code.FailedPrecondition,
      );
      expect(
        await code(
          gw.api.submitPullRequestReview(request("submit_review", { resourceId, verdict: "APPROVE" }), browser),
        ),
      ).toBe(Code.FailedPrecondition);
      expect(await code(gw.api.preparePullRequestMutation(request("discard_review", { resourceId }), browser))).toBe(
        Code.FailedPrecondition,
      );
    }

    expect(
      await code(
        gw.api.setPullRequestReviewThreadResolved(
          request("resolve_thread", { resourceId: foreignThread.id, resolved: true }),
          browser,
        ),
      ),
    ).toBe(Code.NotFound);

    for (const r of [foreign, another]) {
      expect(
        await code(
          gw.api.updatePullRequestComment(
            request("update_comment", { resourceId: r.comments[0]!.id, commentKind: "review", body: "Not allowed" }),
            browser,
          ),
        ),
      ).toBe(Code.NotFound);
      expect(
        await code(
          gw.api.preparePullRequestMutation(
            request("delete_comment", { resourceId: r.comments[0]!.id, commentKind: "review" }),
            browser,
          ),
        ),
      ).toBe(Code.NotFound);
    }

    expect(fixture.writes).toBe(before);
  }, 30_000);

  test("GitHub rejects the PR author's approval and request-changes before writes", async () => {
    fixture.author(101);
    const d = await gw.api.getPullRequestReviewDraft({ pullRequestId: pr, refresh: true }, browser);
    expect(d.viewerIsAuthor).toBe(true);
    const before = fixture.writes;

    for (const v of ["APPROVE", "REQUEST_CHANGES"]) expect(await code(verdict(v))).toBe(Code.PermissionDenied);
    expect(fixture.writes).toBe(before);
    expect((await verdict("COMMENT")).state).toBe("succeeded");
    fixture.author(202);
  }, 30_000);

  test("fresh GitHub rights and a revocation at send time are enforced", async () => {
    const saved = await gw.api.addPullRequestReviewComment({ ...inline(), singleComment: true }, browser);
    const thread = [...fixture.threads.values()].find((t) => t.review.id === saved.upstreamId)!;
    fixture.resolveAllowed(false);
    const page = await gw.api.listPullRequestReviewThreads({ pullRequestId: pr, refresh: true }, browser);
    expect(page.threads.find((t) => t.id === thread.id)?.viewerCanResolve).toBe(false);
    const before = fixture.writes;
    expect(
      await code(
        gw.api.setPullRequestReviewThreadResolved(
          request("resolve_thread", { resourceId: thread.id, resolved: true }),
          browser,
        ),
      ),
    ).toBe(Code.PermissionDenied);
    fixture.resolveAllowed(true);
    fixture.allowed(false);
    expect(await code(gw.api.addPullRequestReviewComment(inline(), browser))).toBe(Code.NotFound);
    expect(fixture.writes).toBe(before);
    fixture.allowed(true);
    fixture.beforeMutation(() => fixture.reject(true));
    expect((await gw.api.addPullRequestReviewComment(inline(), browser)).state).toBe("failed");
    fixture.beforeMutation(() => {});
    fixture.reject(false);
  }, 30_000);

  test("pending pagination cursors and drafts are isolated by account", async () => {
    const pending = fixture.seed(101, 55);
    const first = await gw.api.getPullRequestReviewDraft({ pullRequestId: pr, refresh: true }, browser);
    expect(first.page?.nextCursor).toBeTruthy();
    const second = await connectGitHub(gw, fixture, 102);
    const mapping = await gw.api.getGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy" });
    await gw.api.setGitHubRepositoryAccount({
      repositoryName: "itsoltech/canopy",
      accountId: second,
      expectedRevision: mapping.revision,
    });
    await gw.api.refreshPullRequest({ pullRequestId: pr });
    expect(
      await code(
        gw.api.getPullRequestReviewDraft({ pullRequestId: pr, cursor: first.page!.nextCursor, refresh: true }, browser),
      ),
    ).toBe(Code.FailedPrecondition);
    const own = await gw.api.getPullRequestReviewDraft({ pullRequestId: pr, refresh: true }, browser);
    expect(own.id).not.toBe(pending.id);
    expect(own.comments[0]?.comment?.author).toBe("account-102");
    const current = await gw.api.getGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy" });
    await gw.api.setGitHubRepositoryAccount({
      repositoryName: "itsoltech/canopy",
      accountId: snapshot.accountId,
      expectedRevision: current.revision,
    });
    snapshot = await gw.api.refreshPullRequest({ pullRequestId: pr });
  }, 30_000);

  test("workers and bots cannot spoof the UI actor for any review operation", async () => {
    const before = fixture.writes,
      options = { headers: { ...browser.headers, "canopy-actor": "user" } };

    for (const token of [gw.workerCredential, "bot-fixture-credential"]) {
      const api = caller(gw.grpcUrl, token);

      for (const invoke of [
        () => api.addPullRequestReviewComment(inline(), options),
        () => api.submitPullRequestReview(request("submit_review", { verdict: "APPROVE" }), options),
        () => api.discardPullRequestReview(request("discard_review", { resourceId: "REVIEW_1" }), options),
        () =>
          api.setPullRequestReviewThreadResolved(
            request("resolve_thread", { resourceId: "REVIEW_THREAD_1", resolved: true }),
            options,
          ),
        () => api.getPullRequestReviewDraft({ pullRequestId: pr }, options),
      ])
        expect(await code(invoke())).toBe(Code.Unauthenticated);
    }

    expect(fixture.writes).toBe(before);
  });
});
